import type { HrTime, SpanContext } from '@opentelemetry/api';
import type { InstrumentationScope } from '@opentelemetry/core';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import type { SpanAttributeValue, TraceSnapshot } from '@/types';

interface OtelResourceConfig {
  service?: string;
  version?: string;
  environment?: string;
}

const msToHrTime = (ms: number): HrTime => {
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.floor((ms - seconds * 1000) * 1e6);
  return [seconds, nanos];
};

export const buildResourceAttributes = (
  config: OtelResourceConfig,
): Record<string, SpanAttributeValue> => {
  const attrs: Record<string, SpanAttributeValue> = {};

  if (config.service) attrs[ATTR_SERVICE_NAME] = config.service;
  if (config.version) attrs[ATTR_SERVICE_VERSION] = config.version;
  if (config.environment) attrs['deployment.environment'] = config.environment;

  return attrs;
};

export const defaultSpanKindResolver = (spanName: string): SpanKind =>
  spanName === 'http-request' ? SpanKind.SERVER : SpanKind.INTERNAL;

interface SpanStatus {
  code: SpanStatusCode;
}

export interface SpanHooks {
  mapAttributes?: (
    attributes: Record<string, SpanAttributeValue>,
  ) => Record<string, SpanAttributeValue>;
  statusResolver?: (span: TraceSnapshot['spans'][number]) => SpanStatus;
  spanKindResolver?: (spanName: string) => SpanKind;
}

interface SpanCollectOptions {
  isErrorSpan?: (span: TraceSnapshot['spans'][number]) => boolean;
}

export const toReadableSpan = (
  traceId: string,
  span: TraceSnapshot['spans'][number],
  resource: Resource,
  scope: InstrumentationScope,
  hooks: SpanHooks = {},
): ReadableSpan => {
  const startMs = span.startTime;
  const endMs = span.endTime ?? span.startTime;

  const spanContext: SpanContext = {
    traceId,
    spanId: span.id,
    traceFlags: TraceFlags.SAMPLED,
  };

  const parentSpanContext = span.parentSpanId
    ? ({
        traceId,
        spanId: span.parentSpanId,
        traceFlags: TraceFlags.SAMPLED,
      } as SpanContext)
    : undefined;

  const status = hooks.statusResolver
    ? hooks.statusResolver(span)
    : { code: SpanStatusCode.UNSET };
  const spanKind = (hooks.spanKindResolver ?? defaultSpanKindResolver)(span.name);

  const mapAttributes = hooks.mapAttributes;
  const attributesInput = mapAttributes
    ? { ...span.attributes }
    : (span.attributes as Record<string, SpanAttributeValue>);
  const attributes = mapAttributes ? mapAttributes(attributesInput) : attributesInput;

  return {
    name: span.name,
    kind: spanKind,
    spanContext: () => spanContext,
    parentSpanContext,
    startTime: msToHrTime(startMs),
    endTime: msToHrTime(endMs),
    status,
    attributes,
    links: [],
    events: [],
    duration: msToHrTime(Math.max(0, endMs - startMs)),
    ended: true,
    resource,
    instrumentationScope: scope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
};

/**
 * Converts trace spans into OpenTelemetry ReadableSpan format for export.
 *
 * This function handles the transformation of internal span snapshots into
 * the OpenTelemetry SDK format required by OTLP exporters. It also provides
 * optional error-based filtering behavior used by different loggers.
 *
 * ## Logger Behavior Differences
 *
 * **Axiom Logger**: Always sends all spans for every trace
 * - Does NOT pass `isErrorSpan` option
 * - Every trace is exported regardless of success/failure
 * - Full trace context available for all requests
 *
 * **Sentry Logger**: Only sends traces when errors occur
 * - Passes `isErrorSpan` function to detect error spans
 * - Checks all spans for error status (exceptions or HTTP 5xx)
 * - If no errors found: returns empty array (trace not sent)
 * - If errors found: exports the FULL trace (all spans included)
 * - This provides complete context for debugging errors
 *
 * @param trace - The trace snapshot containing all spans to convert
 * @param resource - OpenTelemetry resource attributes (service name, version, etc.)
 * @param scope - Instrumentation scope identifying this tracer
 * @param hooks - Optional hooks for customizing span transformation:
 *   - `mapAttributes`: Transform/filter span attributes before export
 *   - `statusResolver`: Determine span status code
 *   - `spanKindResolver`: Determine span kind (SERVER, INTERNAL, etc.)
 * @param options - Optional filtering configuration:
 *   - `isErrorSpan`: Function to detect error spans. When provided, the
 *     function will only return spans if at least one error span exists.
 *     Use this for error-only export behavior (e.g., Sentry).
 * @returns Array of ReadableSpan objects ready for OTLP export, or empty
 *   array if filtering is enabled and no errors were found
 *
 * @example
 * ```typescript
 * // Axiom usage - always sends all spans
 * const spans = collectReadableSpans(trace, resource, scope, hooks);
 *
 * // Sentry usage - only sends when there are errors
 * const spans = collectReadableSpans(trace, resource, scope, hooks, {
 *   isErrorSpan,
 * });
 * ```
 */
export const collectReadableSpans = (
  trace: TraceSnapshot,
  resource: Resource,
  scope: InstrumentationScope,
  hooks: SpanHooks = {},
  options: SpanCollectOptions = {},
): Array<ReadableSpan> => {
  const spans = trace.spans;
  const length = spans.length;
  if (length === 0) return [];

  const isErrorSpan = options.isErrorSpan;

  if (isErrorSpan) {
    let hasErrors = false;
    for (let i = 0; i < length; i++) {
      if (isErrorSpan(spans[i]!)) {
        hasErrors = true;
        break;
      }
    }
    if (!hasErrors) return [];
  }

  const out: Array<ReadableSpan> = [];
  for (let i = 0; i < length; i++) {
    const span = spans[i]!;
    out.push(toReadableSpan(trace.id, span, resource, scope, hooks));
  }
  return out;
};

export const exportSpans = (
  exporter: {
    export: (
      spans: Array<ReadableSpan>,
      cb: (result: { code: ExportResultCode; error?: Error }) => void,
    ) => void;
  },
  spans: Array<ReadableSpan>,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    exporter.export(spans, (result) => {
      if (result.code === ExportResultCode.SUCCESS) {
        resolve();
        return;
      }
      reject(result.error ?? new Error('OTLP export failed'));
    });
  });
