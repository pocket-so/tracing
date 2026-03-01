import type { InstrumentationScope } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';

import type {
  Logger,
  LoggerHealth,
  ServiceMetadata,
  SpanAttributeValue,
  TraceSnapshot,
} from '@/types';
import type { SpanHooks } from '@/utils/otlp';

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
}

class SentryLogger implements Logger {
  private static instance: SentryLogger | null = null;

  public readonly id = 'sentry';
  private exporter: OTLPTraceExporter;
  private resource: ReturnType<typeof resourceFromAttributes>;

  private readonly scope: InstrumentationScope = { name: 'tracing' };
  private readonly spanHooks: SpanHooks;

  private lastError?: Error;
  private lastSuccess?: Date;

  private constructor(config: SentryLoggerConfig) {
    const headers: Record<string, string> = {
      'x-sentry-auth': `sentry sentry_key=${config.token}, sentry_version=7, sentry_client=tracing/1.0`,
    };

    this.exporter = new OTLPTraceExporter({
      url: config.endpoint,
      headers,
      timeoutMillis: config.timeoutMs,
    });

    this.resource = resourceFromAttributes(buildResourceAttributes(config.metadata));

    this.spanHooks = {
      spanKindResolver: defaultSpanKindResolver,
      statusResolver,
      mapAttributes: this.mapAttributes,
    };
  }

  static getInstance(config: SentryLoggerConfig): SentryLogger {
    if (!SentryLogger.instance) {
      SentryLogger.instance = new SentryLogger(config);
    }
    return SentryLogger.instance;
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
  commit = async (traces: Array<TraceSnapshot>): Promise<Array<TraceSnapshot>> => {
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

    try {
      await exportSpans(this.exporter, allSpans);
      this.lastSuccess = new Date();
      this.lastError = undefined;
      return []; // All traces committed successfully
    } catch (error) {
      this.lastError = error as Error;
      // All traces failed
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
 * Create a logger that exports traces to Sentry via OTLP.
 *
 * @param config - Options:
 * - endpoint: Sentry OTLP endpoint URL
 * - token: Sentry auth token
 * - metadata: Service metadata
 * - timeoutMs: OTLP batch export timeout (default: 10000)
 */
export const getSentryLogger = (config: SentryLoggerConfig): Logger =>
  SentryLogger.getInstance(config);
