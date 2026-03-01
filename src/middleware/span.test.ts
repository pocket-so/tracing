import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';
import { describe, expect, test } from 'bun:test';

import type { Logger, Span, TraceSnapshot } from '@/types';

import { createTracer } from './tracer';

const createMockLogger = (): Logger & {
  receivedBatches: Array<Array<TraceSnapshot>>;
} => {
  const receivedBatches: Array<Array<TraceSnapshot>> = [];
  return {
    id: 'mock',
    receivedBatches,
    async commit(traces: Array<TraceSnapshot>) {
      receivedBatches.push([...traces]);
      return [];
    },
  };
};

describe('middleware/span', () => {
  test('has id, name, startTime; endTime and duration null until stop', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'span-basic' });
    const span = trace.startSpan({ name: 'http' });

    expect(span.id).toBeDefined();
    expect(span.name).toBe('http');
    expect(span.startTime).toBeGreaterThan(0);
    expect(span.endTime).toBeNull();
    expect(span.duration).toBeNull();

    span.stop();
    trace.finish();

    expect(span.endTime).not.toBeNull();
    expect(span.duration).not.toBeNull();
  });

  test('attributes from config are set; undefined values are skipped', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const span = trace.startSpan({
      name: 'with-attrs',
      attributes: {
        'http.method': 'GET',
        'http.route': '/api',
        skip: undefined as unknown as string,
      },
    });

    expect(span.attributes['http.method']).toBe('GET');
    expect(span.attributes['http.route']).toBe('/api');
    expect(Object.hasOwn(span.attributes, 'skip')).toBe(false);

    trace.finish();
  });

  test('setAttributes merges and invalidates attributes snapshot', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const span = trace.startSpan({
      name: 'merge-attrs',
      attributes: { a: 1 },
    });

    const snap1 = span.attributes;
    const snap2 = span.attributes;
    expect(snap2).toBe(snap1);
    expect(snap1['a']).toBe(1);

    span.setAttributes({ b: 2 });
    const snap3 = span.attributes;
    expect(snap3).not.toBe(snap1);
    expect(snap3['a']).toBe(1);
    expect(snap3['b']).toBe(2);

    trace.finish();
  });

  test('trace and parentSpan getters: root has no parent, child has parent', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'parent-child' });
    const root = trace.startSpan({ name: 'root' });
    const child = root.startSpan({ name: 'child' });

    expect(root.trace).toBe(trace);
    expect(root.parentSpan).toBeNull();
    expect(child.trace).toBe(trace);
    expect(child.parentSpan).toBe(root);

    trace.finish();
  });

  test('childSpans includes spans created via startSpan', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const root = trace.startSpan({ name: 'root' });
    expect(root.childSpans).toHaveLength(0);

    const c1 = root.startSpan({ name: 'c1' });
    expect(root.childSpans).toHaveLength(1);
    expect(root.childSpans[0]?.name).toBe('c1');
    expect(root.childSpans[0]?.id).toBe(c1.id);

    root.startSpan({ name: 'c2' });
    expect(root.childSpans).toHaveLength(2);

    trace.finish();
  });

  test('stop is idempotent', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const span = trace.startSpan({ name: 'idem' });
    span.stop();
    const endAfterFirst = span.endTime;
    const durAfterFirst = span.duration;
    span.stop();
    span.stop();
    expect(span.endTime).toBe(endAfterFirst);
    expect(span.duration).toBe(durAfterFirst);
    trace.finish();
  });

  test('wrap resolves with fn return value and stops child', async () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const root = trace.startSpan({ name: 'root' });
    let receivedSpan: Span | null = null;
    const out = await root.wrap({ name: 'wrapped' }, (s) => {
      receivedSpan = s;
      expect(s.name).toBe('wrapped');
      expect(s.parentSpan).toBe(root);
      return 42;
    });

    expect(out).toBe(42);
    expect(receivedSpan).not.toBeNull();
    const span = receivedSpan as unknown as Span;
    expect(span.endTime).not.toBeNull();
    expect(span.duration).not.toBeNull();
    trace.finish();
  });

  test('wrap on thrown error sets exception attributes and rethrows', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const root = trace.startSpan({ name: 'root' });
    const err = new Error('wrap failed');
    let caughtSpan: Span | null = null;

    expect(
      root.wrap({ name: 'err-span' }, (s) => {
        caughtSpan = s;
        throw err;
      }),
    ).rejects.toThrow('wrap failed');

    expect(caughtSpan).not.toBeNull();
    const errSpan = caughtSpan as unknown as Span;
    expect(errSpan.endTime).not.toBeNull();
    expect(errSpan.attributes[ATTR_EXCEPTION_TYPE]).toBe('Error');
    expect(errSpan.attributes[ATTR_EXCEPTION_MESSAGE]).toBe('wrap failed');
    expect(typeof errSpan.attributes[ATTR_EXCEPTION_STACKTRACE]).toBe('string');
    trace.finish();
  });
});
