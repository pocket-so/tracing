import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_HEADER,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_URL_FULL,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';

import type { Timescale } from '@/db';
import type { InsertTrace } from '@/db/schema/traces/db';
import type { Logger, ServiceMetadata, SpanAttributeValue, TraceSnapshot } from '@/types';

import { Traces } from '@/db/schema/traces/db';
import { DEFAULT_BATCH_SIZE } from '@/utils/constants';

const DUPLICATE_ATTR_KEYS = new Set<string>([
  ATTR_EXCEPTION_TYPE,
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_ROUTE,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_URL_FULL,
  // oxlint-disable-next-line new-cap - required by otlp
  ATTR_HTTP_REQUEST_HEADER('host'),
  // oxlint-disable-next-line new-cap - required by otlp
  ATTR_HTTP_REQUEST_HEADER('user-agent'),
]);

const hasDuplicateKeys = (obj?: Record<string, SpanAttributeValue>): boolean => {
  if (!obj) return false;
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue;
    if (DUPLICATE_ATTR_KEYS.has(key)) return true;
  }
  return false;
};

const buildAttributes = (
  spanAttrs: Record<string, SpanAttributeValue>,
  staticAttrs?: Record<string, SpanAttributeValue>,
): Record<string, SpanAttributeValue> => {
  const spanHasDupes = hasDuplicateKeys(spanAttrs);
  const staticHasDupes = hasDuplicateKeys(staticAttrs);

  if (!spanHasDupes && !staticHasDupes) {
    if (!staticAttrs) return spanAttrs;
    return { ...spanAttrs, ...staticAttrs };
  }

  const out: Record<string, SpanAttributeValue> = {};
  for (const key in spanAttrs) {
    if (!Object.hasOwn(spanAttrs, key)) continue;
    if (DUPLICATE_ATTR_KEYS.has(key)) continue;
    out[key] = spanAttrs[key] as SpanAttributeValue;
  }
  if (staticAttrs) {
    for (const key in staticAttrs) {
      if (!Object.hasOwn(staticAttrs, key)) continue;
      if (DUPLICATE_ATTR_KEYS.has(key)) continue;
      out[key] = staticAttrs[key] as SpanAttributeValue;
    }
  }
  return out;
};

const buildTraceRows = (
  trace: TraceSnapshot,
  meta: { service: string; version: string; environment: string },
): Array<InsertTrace> => {
  const { id: traceId, spans } = trace;
  const { service, version, environment } = meta;
  const rows = new Array<InsertTrace>(spans.length);

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const spanAttrs = span.attributes;
    const attributes = buildAttributes(spanAttrs);

    const exceptionType =
      typeof spanAttrs[ATTR_EXCEPTION_TYPE] === 'string'
        ? spanAttrs[ATTR_EXCEPTION_TYPE]
        : null;
    const exceptionMessage =
      typeof spanAttrs[ATTR_EXCEPTION_MESSAGE] === 'string'
        ? spanAttrs[ATTR_EXCEPTION_MESSAGE]
        : null;
    const exceptionStacktrace =
      typeof spanAttrs[ATTR_EXCEPTION_STACKTRACE] === 'string'
        ? spanAttrs[ATTR_EXCEPTION_STACKTRACE]
        : null;

    const httpMethod =
      typeof spanAttrs[ATTR_HTTP_REQUEST_METHOD] === 'string'
        ? spanAttrs[ATTR_HTTP_REQUEST_METHOD]
        : null;
    const httpRoute =
      typeof spanAttrs[ATTR_HTTP_ROUTE] === 'string' ? spanAttrs[ATTR_HTTP_ROUTE] : null;
    const httpStatusCodeRaw = spanAttrs[ATTR_HTTP_RESPONSE_STATUS_CODE];
    const httpStatusCode =
      typeof httpStatusCodeRaw === 'number' && Number.isFinite(httpStatusCodeRaw)
        ? httpStatusCodeRaw
        : null;
    const httpUrl =
      typeof spanAttrs[ATTR_URL_FULL] === 'string' ? spanAttrs[ATTR_URL_FULL] : null;
    const httpHost =
      typeof spanAttrs[ATTR_SERVER_ADDRESS] === 'string'
        ? spanAttrs[ATTR_SERVER_ADDRESS]
        : null;
    const httpUserAgent =
      typeof spanAttrs[ATTR_USER_AGENT_ORIGINAL] === 'string'
        ? spanAttrs[ATTR_USER_AGENT_ORIGINAL]
        : null;

    rows[i] = {
      traceId,
      spanId: span.id,
      parentSpanId: span.parentSpanId ?? null,
      startTime: new Date(span.startTime),
      endTime: span.endTime ? new Date(span.endTime) : null,
      durationMs: span.duration ?? null,
      attributes,
      exceptionType,
      exceptionMessage,
      exceptionStacktrace,
      httpMethod,
      httpRoute,
      httpStatusCode,
      httpUrl,
      httpHost,
      httpUserAgent,
      service,
      version,
      environment,
    };
  }

  return rows;
};

/**
 * Configuration for TimescaleDB logger.
 */
export interface TimescaleLoggerConfig {
  /** Service metadata */
  metadata: ServiceMetadata;
  /** Batch size for inserts. Default 1000. */
  batchSize?: number;
  /** Drizzle database instance */
  db: Timescale;
}

class TimescaleLogger implements Logger {
  private static instance: TimescaleLogger | null = null;

  public readonly id = 'timescale';

  private batchSize: number;
  private db: TimescaleLoggerConfig['db'];
  private metadata: ServiceMetadata;

  private constructor(config: TimescaleLoggerConfig) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.db = config.db;
    this.metadata = config.metadata;
  }

  /**
   * Returns the singleton instance. First config wins; later calls ignore config.
   */
  static getInstance(config: TimescaleLoggerConfig): TimescaleLogger {
    if (!TimescaleLogger.instance) {
      TimescaleLogger.instance = new TimescaleLogger(config);
    }
    return TimescaleLogger.instance;
  }

  /**
   * Creates a new instance without touching the singleton. Use for tests or multiple configs.
   */
  static create(config: TimescaleLoggerConfig): TimescaleLogger {
    return new TimescaleLogger(config);
  }

  private insertBatch = async (
    rows: Array<InsertTrace>,
    onError?: (error?: Error) => void | undefined,
  ): Promise<boolean> => {
    if (rows.length === 0) return true;
    try {
      await this.db.insert(Traces).values(rows);
      return true;
    } catch (error) {
      onError?.(error as Error);
      return false;
    }
  };

  /**
   * Commit traces to TimescaleDB
   * Returns array of traces that failed to commit (empty array = all success)
   */
  commit = async (
    traces: Array<TraceSnapshot>,
    onError?: (error?: Error) => void | undefined,
  ): Promise<Array<TraceSnapshot>> => {
    const batchSize = Math.max(1, this.batchSize);
    const batch: Array<InsertTrace> = [];
    let hasRows = false;

    for (const trace of traces) {
      if (trace.spans.length === 0) continue;
      const rows = buildTraceRows(trace, this.metadata);
      if (rows.length === 0) continue;
      hasRows = true;
      for (const row of rows) {
        batch.push(row);
        if (batch.length >= batchSize) {
          if (!(await this.insertBatch(batch, onError))) return traces;
          batch.length = 0;
        }
      }
    }

    if (!hasRows) return [];

    return (await this.insertBatch(batch, onError)) ? [] : traces;
  };
}

/**
 * Returns the singleton Timescale logger. First config wins; subsequent calls return the same
 * instance and ignore config. For a new instance (e.g. tests), use createTimescaleLogger.
 *
 * @param config - Options:
 * - metadata: Service metadata
 * - batchSize: Amount of inserts in one batch (Default: 1000)
 * - db: Drizzle database instance
 */
export const getTimescaleLogger = (config: TimescaleLoggerConfig): Logger =>
  TimescaleLogger.getInstance(config);

/**
 * Creates a new Timescale logger instance without using or updating the singleton.
 * Use for tests or when you need multiple instances.
 *
 * @param config - Same as getTimescaleLogger.
 * @returns A new Logger instance.
 */
export const createTimescaleLogger = (config: TimescaleLoggerConfig): Logger =>
  TimescaleLogger.create(config);
