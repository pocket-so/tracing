import type { InstrumentationScope } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions';

import type {
  Logger,
  LoggerHealth,
  ServiceMetadata,
  SpanAttributeValue,
  TraceSnapshot,
} from '@/types';
import type { SpanHooks } from '@/utils/otlp';

import {
  DEFAULT_STACKTRACE_MAX_LENGTH,
  DEFAULT_STACKTRACE_AXIOM_INCLUDE,
} from '@/utils/constants';
import { statusResolver } from '@/utils/errors';
import {
  buildResourceAttributes,
  collectReadableSpans,
  defaultSpanKindResolver,
  exportSpans,
} from '@/utils/otlp';

/**
 * Configuration for Axiom OTLP logger.
 */
export interface AxiomLoggerConfig {
  /** Axiom OTLP endpoint URL */
  endpoint?: string | undefined;
  /** Axiom API token */
  token: string;
  /** Axiom dataset name */
  dataset: string;
  /** Service metadata */
  metadata: ServiceMetadata;
  /** OTLP batch export timeout in ms. */
  timeoutMs?: number;
  /** Include stacktrace attribute in OTLP export. Default false. */
  includeStacktrace?: boolean;
  /** Max length for stacktrace attribute. Default 2000. */
  stacktraceMaxLength?: number;
}

class AxiomLogger implements Logger {
  private static instance: AxiomLogger | null = null;

  public readonly id = 'axiom';

  private exporter: OTLPTraceExporter;
  private resource: ReturnType<typeof resourceFromAttributes>;
  private includeStacktrace: boolean;
  private stacktraceMaxLength: number;

  private readonly scope: InstrumentationScope = { name: 'tracing' };
  private readonly spanHooks: SpanHooks;

  private lastError?: Error;
  private lastSuccess?: Date;

  constructor(config: AxiomLoggerConfig) {
    this.includeStacktrace = config.includeStacktrace ?? DEFAULT_STACKTRACE_AXIOM_INCLUDE;
    this.stacktraceMaxLength =
      config.stacktraceMaxLength ?? DEFAULT_STACKTRACE_MAX_LENGTH;

    this.exporter = new OTLPTraceExporter({
      url: config.endpoint ?? 'https://api.axiom.co/v1/traces',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'X-Axiom-Dataset': config.dataset,
      },
      timeoutMillis: config.timeoutMs,
    });

    this.resource = resourceFromAttributes(buildResourceAttributes(config.metadata));

    this.spanHooks = {
      spanKindResolver: defaultSpanKindResolver,
      mapAttributes: this.mapAttributes,
      statusResolver,
    };
  }

  static getInstance(config: AxiomLoggerConfig): AxiomLogger {
    if (!AxiomLogger.instance) {
      AxiomLogger.instance = new AxiomLogger(config);
    }
    return AxiomLogger.instance;
  }

  private mapAttributes = (
    attributes: Record<string, SpanAttributeValue>,
  ): Record<string, SpanAttributeValue> => {
    const { error: _error, ...rest } = attributes;
    if (!this.includeStacktrace) {
      const { [ATTR_EXCEPTION_STACKTRACE]: _removed, ...filtered } = rest;
      return filtered;
    }
    const stack = rest[ATTR_EXCEPTION_STACKTRACE];
    if (typeof stack === 'string' && stack.length > this.stacktraceMaxLength) {
      return {
        ...rest,
        [ATTR_EXCEPTION_STACKTRACE]: stack.slice(0, this.stacktraceMaxLength),
      };
    }
    return rest;
  };

  /**
   * Commit traces to Axiom
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
      );
      allSpans.push(...spans);
    }

    if (allSpans.length === 0) return [];

    try {
      await exportSpans(this.exporter, allSpans);
      this.lastSuccess = new Date();
      this.lastError = undefined;
      return [];
    } catch (error) {
      this.lastError = error as Error;
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
 * Create a logger that exports traces to Axiom via OTLP.
 *
 * @param config - Options:
 * - endpoint?: Axiom OTLP endpoint URL (default: https://api.axiom.co/v1/traces)
 * - token: Axiom API token
 * - dataset: Axiom dataset name
 * - metadata: Service metadata
 * - includeStacktrace: include exception.stacktrace (default: false)
 * - stacktraceMaxLength: max stacktrace length (default: 2000)
 * - timeoutMs: OTLP batch export timeout (default: 10000)
 */
export const getAxiomLogger = (config: AxiomLoggerConfig): Logger =>
  AxiomLogger.getInstance(config);
