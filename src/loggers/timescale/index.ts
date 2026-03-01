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
import type {
  Logger,
  LoggerHealth,
  ServiceMetadata,
  SpanAttributeValue,
  TraceSnapshot,
} from '@/types';

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

const pickString = (value: SpanAttributeValue | undefined): string | null =>
  typeof value === 'string' ? value : null;
const pickNumber = (value: SpanAttributeValue | undefined): number | null =>
  typeof value === 'number' ? value : null;

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

    const exceptionType = pickString(spanAttrs[ATTR_EXCEPTION_TYPE]);
    const exceptionMessage = pickString(spanAttrs[ATTR_EXCEPTION_MESSAGE]);
    const exceptionStacktrace = pickString(spanAttrs[ATTR_EXCEPTION_STACKTRACE]);

    const httpMethod = pickString(spanAttrs[ATTR_HTTP_REQUEST_METHOD]);
    const httpRoute = pickString(spanAttrs[ATTR_HTTP_ROUTE]);
    const httpStatusCode = pickNumber(spanAttrs[ATTR_HTTP_RESPONSE_STATUS_CODE]);
    const httpUrl = pickString(spanAttrs[ATTR_URL_FULL]);
    const httpHost = pickString(spanAttrs[ATTR_SERVER_ADDRESS]);
    const httpUserAgent = pickString(spanAttrs[ATTR_USER_AGENT_ORIGINAL]);

    rows[i] = {
      traceId,
      spanId: span.id,
      parentSpanId: span.parentSpanId,
      startTime: new Date(span.startTime),
      endTime: span.endTime ? new Date(span.endTime) : null,
      durationMs: span.duration,
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

  private lastError?: Error;
  private lastSuccess?: Date;

  private constructor(config: TimescaleLoggerConfig) {
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.db = config.db;
    this.metadata = config.metadata;
  }

  static getInstance(config: TimescaleLoggerConfig): TimescaleLogger {
    if (!TimescaleLogger.instance) {
      TimescaleLogger.instance = new TimescaleLogger(config);
    }
    return TimescaleLogger.instance;
  }

  private insertBatch = async (rows: Array<InsertTrace>): Promise<void> => {
    if (rows.length === 0) return;
    await this.db.insert(Traces).values(rows);
  };

  /**
   * Commit traces to TimescaleDB
   * Returns array of traces that failed to commit (empty array = all success)
   */
  commit = async (traces: Array<TraceSnapshot>): Promise<Array<TraceSnapshot>> => {
    const batchSize = Math.max(1, this.batchSize);
    const batch: Array<InsertTrace> = [];
    let hasRows = false;

    try {
      for (const trace of traces) {
        if (trace.spans.length === 0) continue;
        const rows = buildTraceRows(trace, this.metadata);
        if (rows.length === 0) continue;
        hasRows = true;
        for (const row of rows) {
          batch.push(row);
          if (batch.length >= batchSize) {
            await this.insertBatch(batch);
            batch.length = 0;
          }
        }
      }

      if (!hasRows) return [];
      if (batch.length > 0) {
        await this.insertBatch(batch);
      }

      this.lastSuccess = new Date();
      this.lastError = undefined;
      return []; // All traces committed successfully
    } catch (error) {
      this.lastError = error as Error;
      // All traces failed (we don't have per-trace granularity for DB errors)
      return traces;
    }
  };

  health = (): LoggerHealth => ({
    healthy: this.lastError === undefined || this.lastSuccess !== undefined,
    lastError: this.lastError,
    lastSuccess: this.lastSuccess,
  });
}

/**
 * Create a logger that exports traces to TimescaleDB.
 *
 * @param config - Options:
 * - metadata: Service metadata
 * - batchSize: Amount of inserts in one batch (Default: 1000)
 * - db: Drizzle database instance
 */
export const getTimescaleLogger = (config: TimescaleLoggerConfig): Logger =>
  TimescaleLogger.getInstance(config);
