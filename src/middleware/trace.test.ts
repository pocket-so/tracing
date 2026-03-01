import { describe, expect, test } from 'bun:test';

import type { Logger, TraceSnapshot } from '@/types';

import type { TraceImpl } from './trace';

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

describe('middleware/trace', () => {
  test('has id, startTime, and endTime/duration null until finish', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'trace-1' });
    expect(trace.id).toBe('trace-1');
    expect(trace.startTime).toBeGreaterThan(0);
    expect(trace.endTime).toBeNull();
    expect(trace.duration).toBeNull();
    expect(trace.isFinished).toBe(false);

    trace.startSpan({ name: 's1' });
    trace.finish();

    expect(trace.endTime).not.toBeNull();
    expect(trace.duration).not.toBeNull();
    expect(trace.isFinished).toBe(true);
  });

  test('spans getter returns spans added by startSpan', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    expect(trace.spans).toHaveLength(0);

    const s1 = trace.startSpan({ name: 'http' });
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]?.name).toBe('http');
    expect(trace.spans[0]?.id).toBe(s1.id);

    trace.startSpan({ name: 'db' });
    expect(trace.spans).toHaveLength(2);
    expect(trace.spans[1]?.name).toBe('db');

    trace.finish();
  });

  test('startSpan on finished trace throws', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    trace.startSpan({ name: 's1' });
    trace.finish();

    expect(() => trace.startSpan({ name: 's2' })).toThrow(
      /Cannot start span on finished trace/,
    );
  });

  test('finish is idempotent', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'idem' });
    trace.startSpan({ name: 's' });
    trace.finish();
    trace.finish();
    trace.finish();

    expect(trace.isFinished).toBe(true);
    expect(logger.receivedBatches).toHaveLength(0);
  });

  test('finish stops any open spans', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const s1 = trace.startSpan({ name: 'open' });
    expect(s1.endTime).toBeNull();

    trace.finish();
    expect(s1.endTime).not.toBeNull();
    expect(s1.duration).not.toBeNull();
  });

  test('commits snapshot with correct shape and nested spans', async () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'snap-trace' });
    const root = trace.startSpan({ name: 'root' });
    const child = root.startSpan({ name: 'child' });
    root.stop();
    child.stop();
    trace.finish();
    await tracer.dispose();

    expect(logger.receivedBatches).toHaveLength(1);
    expect(logger.receivedBatches[0]).toHaveLength(1);
    const snap = logger.receivedBatches[0]?.[0];
    expect(snap).toBeDefined();
    if (!snap) {
      return;
    }

    expect(snap.id).toBe('snap-trace');
    expect(snap.startTime).toBe(trace.startTime);
    expect(snap.endTime).toBe(trace.endTime);
    expect(snap.duration).toBe(trace.duration);
    expect(snap.spans).toHaveLength(2);

    const rootSnap = snap.spans.find((s) => s.name === 'root');
    const childSnap = snap.spans.find((s) => s.name === 'child');
    expect(rootSnap?.parentSpanId).toBeNull();
    expect(childSnap?.parentSpanId).toBe(root.id);
    expect(childSnap?.traceId).toBe('snap-trace');
  });

  test('hasErrorSpan returns false when no error attributes', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    trace.startSpan({ name: 'ok', attributes: { 'http.status': 200 } });
    trace.finish();

    expect((trace as TraceImpl).hasErrorSpan()).toBe(false);
  });

  test('hasErrorSpan returns true when span has exception.type', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    const span = trace.startSpan({ name: 'err' });
    span.setAttributes({ 'exception.type': 'Error' });
    trace.finish();

    expect((trace as TraceImpl).hasErrorSpan()).toBe(true);
  });

  test('hasErrorSpan returns true when span has 5xx status', () => {
    const logger = createMockLogger();
    const tracer = createTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    trace.startSpan({
      name: 'server-error',
      attributes: { 'http.response.status_code': 503 },
    });
    trace.finish();

    expect((trace as TraceImpl).hasErrorSpan()).toBe(true);
  });
});
