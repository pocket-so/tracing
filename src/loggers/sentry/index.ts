import type { InstrumentationScope } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

import type { Logger, ServiceMetadata, SpanAttributeValue, TraceSnapshot } from '@/types';
import type { SpanHooks } from '@/utils/otlp';

import { DEFAULT_LOGGER_TIMEOUT_MS } from '@/utils/constants';
import { isErrorSpan, statusResolver } from '@/utils/errors';
import {
  buildResourceAttributes,
  collectReadableSpans,
  defaultSpanKindResolver,
  exportSpans,
} from '@/utils/otlp';

/**
 * Configuration for Sentry OTLP logger.
 */
export interface SentryLoggerConfig {
  /** Sentry OTLP endpoint URL */
  endpoint: string;
  /** Sentry auth token */
  token: string;
  /** Service metadata */
  metadata: ServiceMetadata;
  /** OTLP batch export timeout in ms. */
  timeoutMs?: number;
  /** Optional OTLP exporter (for tests). When set, used instead of creating one. */
  exporter?: SpanExporter;
}

class SentryLogger implements Logger {
  private static instance: SentryLogger | null = null;

  public readonly id = 'sentry';
  private exporter: SpanExporter;
  private resource: ReturnType<typeof resourceFromAttributes>;

  private readonly scope: InstrumentationScope = { name: 'tracing' };
  private readonly spanHooks: SpanHooks;

  private constructor(config: SentryLoggerConfig) {
    const headers: Record<string, string> = {
      'x-sentry-auth': `sentry sentry_key=${config.token}, sentry_version=7, sentry_client=tracing/1.0`,
    };

    this.exporter =
      config.exporter ??
      new OTLPTraceExporter({
        url: config.endpoint,
        headers,
        timeoutMillis: config.timeoutMs ?? DEFAULT_LOGGER_TIMEOUT_MS,
      });

    this.resource = resourceFromAttributes(buildResourceAttributes(config.metadata));

    this.spanHooks = {
      spanKindResolver: defaultSpanKindResolver,
      statusResolver,
      mapAttributes: this.mapAttributes,
    };
  }

  /**
   * Returns the singleton instance. First config wins; later calls ignore config.
   */
  static getInstance(config: SentryLoggerConfig): SentryLogger {
    if (!SentryLogger.instance) {
      SentryLogger.instance = new SentryLogger(config);
    }
    return SentryLogger.instance;
  }

  /**
   * Creates a new instance without touching the singleton. Use for tests or multiple configs.
   */
  static create(config: SentryLoggerConfig): SentryLogger {
    return new SentryLogger(config);
  }

  private mapAttributes = (
    attributes: Record<string, SpanAttributeValue>,
  ): Record<string, SpanAttributeValue> => {
    const { error: _error, ...rest } = attributes;
    return rest;
  };

  /**
   * Commit traces to Sentry (only error traces)
   * Returns array of traces that failed to commit (empty array = all success)
   */
  commit = async (
    traces: Array<TraceSnapshot>,
    onError?: (error?: Error) => void | undefined,
  ): Promise<Array<TraceSnapshot>> => {
    const allSpans: Array<ReadableSpan> = [];

    for (const trace of traces) {
      if (trace.spans.length === 0) continue;
      const spans = collectReadableSpans(
        trace,
        this.resource,
        this.scope,
        this.spanHooks,
        {
          isErrorSpan,
        },
      );
      allSpans.push(...spans);
    }

    // If no error spans, return empty (success - nothing to send)
    if (allSpans.length === 0) return [];

    return (await exportSpans({ exporter: this.exporter, spans: allSpans, onError }))
      ? []
      : traces;
  };
}

/**
 * Returns the singleton Sentry logger. First config wins; subsequent calls return the same
 * instance and ignore config. For a new instance (e.g. tests), use createSentryLogger.
 *
 * @param config - Options:
 * - endpoint: Sentry OTLP endpoint URL
 * - token: Sentry auth token
 * - metadata: Service metadata
 * - timeoutMs: OTLP batch export timeout (default: 10000, from DEFAULT_LOGGER_TIMEOUT_MS)
 */
export const getSentryLogger = (config: SentryLoggerConfig): Logger =>
  SentryLogger.getInstance(config);

/**
 * Creates a new Sentry logger instance without using or updating the singleton.
 * Use for tests or when you need multiple instances.
 *
 * @param config - Same as getSentryLogger.
 * @returns A new Logger instance.
 */
export const createSentryLogger = (config: SentryLoggerConfig): Logger =>
  SentryLogger.create(config);
