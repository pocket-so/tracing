import type { InstrumentationScope } from '@opentelemetry/core';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';

import { SpanKind, SpanStatusCode, TraceFlags } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { describe, expect, test } from 'bun:test';

import type { TraceSnapshot } from '@/types';

import {
  buildResourceAttributes,
  collectReadableSpans,
  defaultSpanKindResolver,
  exportSpans,
  toReadableSpan,
} from './otlp';

const resource = {} as Resource;
const scope = {} as InstrumentationScope;

const makeSpan = (overrides: Partial<TraceSnapshot['spans'][number]> = {}) => ({
  id: 'span-1',
  traceId: 'trace-1',
  parentSpanId: null,
  name: 'test-span',
  startTime: 1000,
  endTime: 2000,
  duration: 1000,
  attributes: {},
  ...overrides,
});

const mockShutdown = (): Promise<void> => Promise.resolve();

describe('utils/otlp', () => {
  describe('buildResourceAttributes', () => {
    test('empty config returns empty object', () => {
      expect(buildResourceAttributes({})).toEqual({});
    });

    test('all keys set returns all attributes', () => {
      expect(
        buildResourceAttributes({
          service: 'api',
          version: '2.0.0',
          environment: 'staging',
        }),
      ).toEqual({
        [ATTR_SERVICE_NAME]: 'api',
        [ATTR_SERVICE_VERSION]: '2.0.0',
        'deployment.environment': 'staging',
      });
    });

    test('partial config only sets present keys', () => {
      expect(buildResourceAttributes({ service: 'svc' })).toEqual({
        [ATTR_SERVICE_NAME]: 'svc',
      });
      expect(buildResourceAttributes({ version: '1.0.0' })).toEqual({
        [ATTR_SERVICE_VERSION]: '1.0.0',
      });
      expect(buildResourceAttributes({ environment: 'prod' })).toEqual({
        'deployment.environment': 'prod',
      });
      expect(buildResourceAttributes({ service: 'x', environment: 'staging' })).toEqual({
        [ATTR_SERVICE_NAME]: 'x',
        'deployment.environment': 'staging',
      });
    });
  });

  describe('defaultSpanKindResolver', () => {
    test('"http-request" returns SERVER', () => {
      expect(defaultSpanKindResolver('http-request')).toBe(SpanKind.SERVER);
    });

    test('other names return INTERNAL', () => {
      expect(defaultSpanKindResolver('db')).toBe(SpanKind.INTERNAL);
      expect(defaultSpanKindResolver('internal')).toBe(SpanKind.INTERNAL);
      expect(defaultSpanKindResolver('')).toBe(SpanKind.INTERNAL);
    });
  });

  describe('toReadableSpan', () => {
    test('maps name, traceId, spanId, and traceFlags', () => {
      const span = makeSpan({ name: 'http-request', id: 'sid-123' });
      const traceId = 'tid-456';
      const out = toReadableSpan(traceId, span, resource, scope);
      const ctx = out.spanContext();

      expect(out.name).toBe('http-request');
      expect(ctx.traceId).toBe(traceId);
      expect(ctx.spanId).toBe('sid-123');
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    });

    test('uses startTime for endTime when endTime is null', () => {
      const span = makeSpan({ startTime: 5000, endTime: null, duration: null });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.endTime).toEqual([5, 0]);
      expect(out.duration).toEqual([0, 0]);
    });

    test('converts start/end ms to HrTime', () => {
      const span = makeSpan({ startTime: 1000, endTime: 2500 });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.startTime).toEqual([1, 0]);
      expect(out.endTime).toEqual([2, 500_000_000]);
      expect(out.duration).toEqual([1, 500_000_000]);
    });

    test('negative timestamps are clamped to zero', () => {
      const span = makeSpan({ startTime: 5000, endTime: 4500 });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.startTime).toEqual([5, 0]);
      expect(out.endTime).toEqual([4, 500_000_000]);
      expect(out.duration).toEqual([0, 0]);
    });

    test('parentSpanContext undefined when parentSpanId is null', () => {
      const span = makeSpan({ parentSpanId: null });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.parentSpanContext).toBeUndefined();
    });

    test('parentSpanContext set when parentSpanId present', () => {
      const span = makeSpan({ parentSpanId: 'parent-1' });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.parentSpanContext).toBeDefined();
      expect(out.parentSpanContext!.spanId).toBe('parent-1');
      expect(out.parentSpanContext!.traceId).toBe('t');
    });

    test('default status is UNSET when no statusResolver', () => {
      const span = makeSpan();
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.status).toEqual({ code: SpanStatusCode.UNSET });
    });

    test('statusResolver hook sets status', () => {
      const span = makeSpan();
      const out = toReadableSpan('t', span, resource, scope, {
        statusResolver: () => ({ code: SpanStatusCode.ERROR }),
      });

      expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
    });

    test('spanKindResolver hook overrides kind', () => {
      const span = makeSpan({ name: 'custom' });
      const out = toReadableSpan('t', span, resource, scope, {
        spanKindResolver: () => SpanKind.CLIENT,
      });

      expect(out.kind).toBe(SpanKind.CLIENT);
    });

    test('default spanKindResolver used for http-request vs other', () => {
      const serverSpan = makeSpan({ name: 'http-request' });
      const internalSpan = makeSpan({ name: 'db' });

      expect(toReadableSpan('t', serverSpan, resource, scope).kind).toBe(SpanKind.SERVER);
      expect(toReadableSpan('t', internalSpan, resource, scope).kind).toBe(
        SpanKind.INTERNAL,
      );
    });

    test('mapAttributes hook transforms attributes', () => {
      const span = makeSpan({ attributes: { foo: 'bar' } });
      const out = toReadableSpan('t', span, resource, scope, {
        mapAttributes: (attrs) => ({ ...attrs, filtered: true }),
      });

      expect(out.attributes).toEqual({ foo: 'bar', filtered: true });
    });

    test('without mapAttributes, span attributes passed through', () => {
      const span = makeSpan({ attributes: { a: 1, b: 'two' } });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.attributes).toEqual({ a: 1, b: 'two' });
    });

    test('ended is true', () => {
      const out = toReadableSpan('t', makeSpan(), resource, scope);

      expect(out.ended).toBe(true);
    });

    test('mapAttributes receives a copy of span attributes', () => {
      const span = makeSpan({ attributes: { a: 1 } });
      let receivedAttrs: Record<string, unknown> = {};
      toReadableSpan('t', span, resource, scope, {
        mapAttributes: (attrs) => {
          receivedAttrs = attrs;
          return { ...attrs, b: 2 };
        },
      });

      expect(receivedAttrs).toEqual({ a: 1 });
      expect(span.attributes).toEqual({ a: 1 });
    });

    test('statusResolver receives the span', () => {
      const span = makeSpan({ attributes: { 'http.status_code': 500 } });
      const out = toReadableSpan('t', span, resource, scope, {
        statusResolver: (s) =>
          (s.attributes['http.status_code'] as number) >= 500
            ? { code: SpanStatusCode.ERROR }
            : { code: SpanStatusCode.UNSET },
      });

      expect(out.status).toEqual({ code: SpanStatusCode.ERROR });
    });

    test('spanKindResolver is called with span name', () => {
      const span = makeSpan({ name: 'db-query' });
      const out = toReadableSpan('t', span, resource, scope, {
        spanKindResolver: (name) =>
          name === 'db-query' ? SpanKind.CLIENT : SpanKind.INTERNAL,
      });

      expect(out.kind).toBe(SpanKind.CLIENT);
    });

    test('links, events, and dropped counts are fixed', () => {
      const out = toReadableSpan('t', makeSpan(), resource, scope);

      expect(out.links).toEqual([]);
      expect(out.events).toEqual([]);
      expect(out.droppedAttributesCount).toBe(0);
      expect(out.droppedEventsCount).toBe(0);
      expect(out.droppedLinksCount).toBe(0);
    });

    test('resource and instrumentationScope are passed through', () => {
      const out = toReadableSpan('t', makeSpan(), resource, scope);

      expect(out.resource).toBe(resource);
      expect(out.instrumentationScope).toBe(scope);
    });

    test('sub-millisecond duration converts to nanos', () => {
      const span = makeSpan({ startTime: 1000, endTime: 1000.25 });
      const out = toReadableSpan('t', span, resource, scope);

      expect(out.duration).toEqual([0, 250_000]);
    });
  });

  describe('collectReadableSpans', () => {
    test('empty spans returns empty array', () => {
      const trace: TraceSnapshot = {
        id: 't1',
        startTime: 0,
        endTime: 1,
        duration: 1,
        spans: [],
      };

      expect(collectReadableSpans(trace, resource, scope)).toEqual([]);
    });

    test('without isErrorSpan returns all spans', () => {
      const trace: TraceSnapshot = {
        id: 't1',
        startTime: 0,
        endTime: 10,
        duration: 10,
        spans: [makeSpan({ name: 'a' }), makeSpan({ name: 'b' })],
      };

      const out = collectReadableSpans(trace, resource, scope);

      expect(out).toHaveLength(2);
      expect(out[0]!.name).toBe('a');
      expect(out[1]!.name).toBe('b');
    });

    test('with isErrorSpan and no errors returns empty array', () => {
      const trace: TraceSnapshot = {
        id: 't1',
        startTime: 0,
        endTime: 10,
        duration: 10,
        spans: [makeSpan({ name: 'a' }), makeSpan({ name: 'b' })],
      };

      const out = collectReadableSpans(
        trace,
        resource,
        scope,
        {},
        {
          isErrorSpan: () => false,
        },
      );

      expect(out).toEqual([]);
    });

    test('with isErrorSpan and at least one error returns full trace', () => {
      const trace: TraceSnapshot = {
        id: 't1',
        startTime: 0,
        endTime: 10,
        duration: 10,
        spans: [
          makeSpan({ name: 'a' }),
          makeSpan({ name: 'b', attributes: { 'exception.message': 'err' } }),
        ],
      };

      const out = collectReadableSpans(
        trace,
        resource,
        scope,
        {},
        {
          isErrorSpan: (s) => s.attributes['exception.message'] !== undefined,
        },
      );

      expect(out).toHaveLength(2);
      expect(out[0]!.name).toBe('a');
      expect(out[1]!.name).toBe('b');
    });

    test('output spans use trace.id as traceId', () => {
      const trace: TraceSnapshot = {
        id: 'trace-xyz',
        startTime: 0,
        endTime: 1,
        duration: 1,
        spans: [makeSpan({ id: 's1' })],
      };

      const out = collectReadableSpans(trace, resource, scope);

      expect(out).toHaveLength(1);
      expect(out[0]!.spanContext().traceId).toBe('trace-xyz');
    });

    test('single-span trace with isErrorSpan true returns that span', () => {
      const trace: TraceSnapshot = {
        id: 't1',
        startTime: 0,
        endTime: 1,
        duration: 1,
        spans: [makeSpan({ name: 'only', attributes: { error: true } })],
      };

      const out = collectReadableSpans(
        trace,
        resource,
        scope,
        {},
        {
          isErrorSpan: (s) => s.attributes['error'] === true,
        },
      );

      expect(out).toHaveLength(1);
      expect(out[0]!.name).toBe('only');
    });
  });

  describe('exportSpans', () => {
    test('resolves true when export succeeds', () => {
      const exporter = {
        export: (
          _spans: unknown[],
          cb: (result: { code: typeof ExportResultCode.SUCCESS }) => void,
        ) => {
          setTimeout(() => cb({ code: ExportResultCode.SUCCESS }), 0);
        },
        shutdown: mockShutdown,
      };

      expect(exportSpans({ exporter, spans: [] })).resolves.toBe(true);
    });

    test('onError is not called when export succeeds', async () => {
      const exporter = {
        export: (
          _spans: unknown[],
          cb: (result: { code: typeof ExportResultCode.SUCCESS }) => void,
        ) => {
          setTimeout(() => cb({ code: ExportResultCode.SUCCESS }), 0);
        },
        shutdown: mockShutdown,
      };

      let onErrorCalled = false;
      await exportSpans({
        exporter,
        spans: [],
        onError: () => {
          onErrorCalled = true;
        },
      });

      expect(onErrorCalled).toBe(false);
    });

    test('exporter receives the same spans array', async () => {
      const spans: ReadableSpan[] = [
        toReadableSpan('t', makeSpan({ name: 'x' }), resource, scope),
      ];
      let receivedSpans: ReadableSpan[] | null = null;
      const exporter = {
        export: (
          s: ReadableSpan[],
          cb: (result: { code: typeof ExportResultCode.SUCCESS }) => void,
        ) => {
          receivedSpans = s;
          setTimeout(() => cb({ code: ExportResultCode.SUCCESS }), 0);
        },
        shutdown: mockShutdown,
      };

      await exportSpans({ exporter, spans });

      expect(receivedSpans).not.toBeNull();
      expect(receivedSpans === spans).toBe(true);
      expect(receivedSpans).toHaveLength(1);
      expect(receivedSpans![0]).toHaveProperty('name', 'x');
    });

    test('resolves false when export fails with error', () => {
      const err = new Error('export failed');
      const exporter = {
        export: (
          _spans: unknown[],
          cb: (result: { code: typeof ExportResultCode.FAILED; error?: Error }) => void,
        ) => {
          setTimeout(() => cb({ code: ExportResultCode.FAILED, error: err }), 0);
        },
        shutdown: mockShutdown,
      };

      expect(exportSpans({ exporter, spans: [] })).resolves.toBe(false);
    });

    test('resolves false when export fails without error object', () => {
      const exporter = {
        export: (
          _spans: unknown[],
          cb: (result: { code: typeof ExportResultCode.FAILED }) => void,
        ) => {
          setTimeout(() => cb({ code: ExportResultCode.FAILED }), 0);
        },
        shutdown: mockShutdown,
      };

      expect(exportSpans({ exporter, spans: [] })).resolves.toBe(false);
    });

    test('calls onError with error when export fails', () => {
      const err = new Error('network error');
      let received: Error | undefined = undefined;
      const handleError: (error?: Error) => void = (e) => {
        received = e;
      };
      const exporter = {
        export: (
          _spans: unknown[],
          cb: (result: { code: typeof ExportResultCode.FAILED; error?: Error }) => void,
        ) => {
          setTimeout(() => cb({ code: ExportResultCode.FAILED, error: err }), 0);
        },
        shutdown: mockShutdown,
      };

      type ExportSpansArg = Parameters<typeof exportSpans>[0];
      expect(
        exportSpans({
          exporter,
          spans: [],
          onError: handleError,
        } as ExportSpansArg),
      ).resolves.toBe(false);

      expect(received!).toBe(err);
    });

    test('does not throw when export fails', () => {
      const exporter = {
        export: (
          _spans: unknown[],
          cb: (result: { code: typeof ExportResultCode.FAILED }) => void,
        ) => {
          setTimeout(() => cb({ code: ExportResultCode.FAILED }), 0);
        },
        shutdown: mockShutdown,
      };

      expect(exportSpans({ exporter, spans: [] })).resolves.toBe(false);
    });
  });
});
