import { afterEach, describe, expect, test } from 'bun:test';

import type { Logger, TraceSnapshot } from '@/types';

import { createTracer } from './tracer';

const createdTracers: Array<ReturnType<typeof createTracer>> = [];

const WAIT_FOR_TIMEOUT_MS = 500;
const WAIT_FOR_INTERVAL_MS = 5;
const TEST_ON_ERROR_CALLBACK = (_error?: Error): void => undefined;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  assertion: () => void,
  timeoutMs: number = WAIT_FOR_TIMEOUT_MS,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = undefined;

  while (Date.now() <= deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await wait(WAIT_FOR_INTERVAL_MS);
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('waitFor timed out');
};

const createTestTracer = (
  config: Parameters<typeof createTracer>[0],
): ReturnType<typeof createTracer> => {
  const tracer = createTracer(config);
  createdTracers.push(tracer);
  return tracer;
};

const createMockLogger = (
  options: {
    id?: string;
    failTraces?: Set<string>;
    throwOnCommit?: boolean;
  } = {},
): Logger & { receivedBatches: Array<Array<TraceSnapshot>> } => {
  const id = options.id ?? 'mock';
  const failTraces = options.failTraces ?? new Set<string>();
  const throwOnCommit = options.throwOnCommit ?? false;
  const receivedBatches: Array<Array<TraceSnapshot>> = [];

  return {
    id,
    receivedBatches,
    async commit(traces: Array<TraceSnapshot>) {
      receivedBatches.push([...traces]);
      if (throwOnCommit) throw new Error('commit failed');
      return traces.filter((t) => failTraces.has(t.id));
    },
  };
};

afterEach(async () => {
  while (createdTracers.length > 0) {
    const tracer = createdTracers.pop();
    if (!tracer) continue;
    await tracer.dispose();
  }
});

describe('middleware/tracer', () => {
  describe('createTracer', () => {
  test('returns a Tracer with startTrace, getStats, dispose', () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({ loggers: [logger] });

    expect(typeof tracer.startTrace).toBe('function');
    expect(typeof tracer.getStats).toBe('function');
    expect(typeof tracer.dispose).toBe('function');
  });

  test('merges config with defaults', () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 5,
      batchSize: 10,
    });

    const trace = tracer.startTrace({ id: 'uses-defaults' });
    trace.startSpan({ name: 's' });
    trace.finish();

    const postFinishStats = tracer.getStats();
    expect(postFinishStats.pending).toBe(1);
    expect(logger.receivedBatches).toHaveLength(0);
  });
  });

  describe('TracerImpl', () => {
  test('startTrace returns a trace with id and finish()', () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace();
    expect(trace.id).toBeDefined();
    expect(typeof trace.finish).toBe('function');
    trace.startSpan({ name: 'span-1' });
    trace.finish();
  });

  test('startTrace accepts custom id', () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 100,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'custom-trace-id' });
    expect(trace.id).toBe('custom-trace-id');
    trace.finish();
  });

  test('getStats reflects active and pending counts', () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 10,
      interval: 30_000,
    });

    let stats = tracer.getStats();
    expect(stats.active).toBe(0);
    expect(stats.pending).toBe(0);

    const t1 = tracer.startTrace();
    stats = tracer.getStats();
    expect(stats.active).toBe(1);

    t1.finish();
    stats = tracer.getStats();
    expect(stats.active).toBe(0);
    expect(stats.pending).toBe(1);
  });

  test('commit is triggered when pending reaches threshold', async () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 2,
      batchSize: 10,
      interval: 30_000,
    });

    const t1 = tracer.startTrace({ id: 'trace-1' });
    t1.startSpan({ name: 's1' });
    t1.finish();

    const t2 = tracer.startTrace({ id: 'trace-2' });
    t2.startSpan({ name: 's2' });
    t2.finish();

    await waitFor(() => {
      expect(logger.receivedBatches).toHaveLength(1);
    });

    expect(logger.receivedBatches[0]?.length).toBe(2);
    const ids = (logger.receivedBatches[0] ?? []).map((t) => t.id).toSorted();
    expect(ids).toEqual(['trace-1', 'trace-2']);
  });

  test('dispose flushes pending traces', async () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 10,
      batchSize: 10,
      interval: 30_000,
    });

    const t1 = tracer.startTrace({ id: 'trace-a' });
    t1.startSpan({ name: 's1' });
    t1.finish();

    await tracer.dispose();

    expect(logger.receivedBatches.length).toBe(1);
    expect(logger.receivedBatches[0]?.length).toBe(1);
    expect(logger.receivedBatches[0]?.[0]?.id).toBe('trace-a');
  });

  test('getStats includes committed and byLogger after commit', async () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 1,
      batchSize: 10,
      interval: 30_000,
    });

    const t = tracer.startTrace();
    t.startSpan({ name: 's' });
    t.finish();

    await waitFor(() => {
      expect(tracer.getStats().committed).toBe(1);
    });
    const stats = tracer.getStats();
    expect(stats.committed).toBe(1);
    expect(stats.byLogger.get('mock')).toEqual({ committed: 1, failed: 0 });
  });

  test('failed traces are retried and eventually committed', async () => {
    let commitCallCount = 0;
    const logger: Logger & { receivedBatches: Array<Array<TraceSnapshot>> } = {
      id: 'mock',
      receivedBatches: [],
      async commit(traces: Array<TraceSnapshot>) {
        this.receivedBatches.push([...traces]);
        commitCallCount++;
        return commitCallCount === 1 ? traces : [];
      },
    };

    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 1,
      batchSize: 10,
      interval: 30_000,
      maxRetries: 2,
      retryDelay: 5,
    });

    const t = tracer.startTrace({ id: 'trace-fail' });
    t.startSpan({ name: 's' });
    t.finish();

    await waitFor(() => {
      expect(commitCallCount).toBe(2);
      expect(tracer.getStats().committed).toBe(1);
    });

    const stats = tracer.getStats();
    expect(logger.receivedBatches).toHaveLength(2);
    expect(stats.pending).toBe(0);
    expect(stats.failed).toBe(0);
    expect(stats.byLogger.get('mock')).toEqual({ committed: 1, failed: 0 });
  });

  test('logger commit throwing requeues then commits on the next loop iteration', async () => {
    let throwCount = 0;
    const logger: Logger & { receivedBatches: Array<Array<TraceSnapshot>> } = {
      id: 'mock',
      receivedBatches: [],
      async commit(traces: Array<TraceSnapshot>) {
        this.receivedBatches.push([...traces]);
        throwCount++;
        if (throwCount === 1) throw new Error('commit failed');
        return [];
      },
    };
    const errorSpy = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    };

    try {
      const tracer = createTestTracer({
        loggers: [logger],
        threshold: 1,
        batchSize: 10,
        interval: 30_000,
        maxRetries: 2,
        retryDelay: 5,
      });

      const t = tracer.startTrace({ id: 'trace-throw' });
      t.startSpan({ name: 's' });
      t.finish();

      await waitFor(() => {
        expect(logger.receivedBatches).toHaveLength(2);
        expect(tracer.getStats().committed).toBe(1);
      });

      const stats = tracer.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.failed).toBe(1);
      expect(stats.byLogger.get('mock')).toEqual({ committed: 1, failed: 1 });
      expect(errors.some((entry) => entry.includes('Logger mock commit failed'))).toBe(
        true,
      );
    } finally {
      console.error = errorSpy;
    }
  });

  test('multiple loggers all receive the same batch', async () => {
    const loggerA = createMockLogger({ id: 'logger-a' });
    const loggerB = createMockLogger({ id: 'logger-b' });
    const tracer = createTestTracer({
      loggers: [loggerA, loggerB],
      threshold: 1,
      batchSize: 10,
      interval: 30_000,
    });

    const t = tracer.startTrace({ id: 'trace-multi' });
    t.startSpan({ name: 's' });
    t.finish();

    await waitFor(() => {
      expect(loggerA.receivedBatches).toHaveLength(1);
      expect(loggerB.receivedBatches).toHaveLength(1);
    });

    expect(loggerA.receivedBatches[0]?.[0]?.id).toBe('trace-multi');
    expect(loggerB.receivedBatches[0]?.[0]?.id).toBe('trace-multi');
  });

  test('batchSize limits traces per flush', async () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 2,
      batchSize: 2,
      interval: 30_000,
    });

    for (let i = 0; i < 4; i++) {
      const t = tracer.startTrace({ id: `trace-${i}` });
      t.startSpan({ name: 's' });
      t.finish();
    }

    await waitFor(() => {
      expect(logger.receivedBatches.length).toBeGreaterThanOrEqual(2);
    });

    const firstBatch = logger.receivedBatches[0] ?? [];
    const secondBatch = logger.receivedBatches[1] ?? [];
    expect(firstBatch.length).toBe(2);
    expect(secondBatch.length).toBe(2);
  });

  test('maxPendingTraces evicts non-error traces when exceeded', async () => {
    const warnSpy = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };

    try {
      const logger = createMockLogger();
      const tracer = createTestTracer({
        loggers: [logger],
        threshold: 1000,
        batchSize: 10,
        interval: 30_000,
        maxPendingTraces: 3,
      });

      for (let i = 0; i < 5; i++) {
        const t = tracer.startTrace({ id: `trace-${i}` });
        t.startSpan({ name: 's' });
        t.finish();
      }

      const stats = tracer.getStats();
      expect(stats.pending).toBe(3);
      expect(warnings.some((entry) => entry.includes('Evicted'))).toBe(true);

      await tracer.dispose();
      const flushedIds = logger.receivedBatches
        .flat()
        .map((trace) => trace.id)
        .toSorted();
      expect(flushedIds).toEqual(['trace-2', 'trace-3', 'trace-4']);
    } finally {
      console.warn = warnSpy;
    }
  });

  test('passes onError callback to logger commit', async () => {
    let receivedOnError: ((error?: Error) => void | undefined) | undefined = undefined;
    const logger: Logger & { receivedBatches: Array<Array<TraceSnapshot>> } = {
      id: 'mock',
      receivedBatches: [],
      async commit(
        traces: Array<TraceSnapshot>,
        commitOnError?: typeof TEST_ON_ERROR_CALLBACK,
      ) {
        receivedOnError = commitOnError;
        this.receivedBatches.push([...traces]);
        return [];
      },
    };
    const tracer = createTestTracer({
      loggers: [logger],
      onError: TEST_ON_ERROR_CALLBACK,
      threshold: 1,
      interval: 30_000,
    });

    const trace = tracer.startTrace({ id: 'trace-with-on-error' });
    trace.startSpan({ name: 's' });
    trace.finish();

    await waitFor(() => {
      expect(receivedOnError).toBe(TEST_ON_ERROR_CALLBACK);
      expect(logger.receivedBatches).toHaveLength(1);
    });
  });

  test('dispose clears commit timer and stops further commits', async () => {
    const logger = createMockLogger();
    const tracer = createTestTracer({
      loggers: [logger],
      threshold: 100,
      interval: 10,
    });

    await tracer.dispose();

    const t = tracer.startTrace();
    t.finish();

    await wait(40);

    const stats = tracer.getStats();
    expect(stats.pending).toBe(1);
    expect(logger.receivedBatches.length).toBe(0);
  });
  });
});
