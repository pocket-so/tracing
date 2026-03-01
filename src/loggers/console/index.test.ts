import { afterEach, describe, expect, test } from 'bun:test';

import type { TraceSnapshot } from '@/types';

import { createConsoleLogger, getConsoleLogger } from './index';

const metadata = {
  service: 'api',
  version: '1.0.0',
  environment: 'test',
} as const;

const makeTrace = (
  id: string,
  spanCount: number,
): TraceSnapshot => ({
  id,
  startTime: 0,
  endTime: 1,
  duration: 1,
  spans: Array.from({ length: spanCount }, (_, index) => ({
    id: `${id}-span-${index}`,
    traceId: id,
    parentSpanId: null,
    name: 'http-request',
    startTime: 0,
    endTime: 1,
    duration: 1,
    attributes: {},
  })),
});

describe('loggers/console', () => {
  const originalConsoleLog = console.log;

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  test('createConsoleLogger has id "console"', () => {
    expect(createConsoleLogger({ metadata }).id).toBe('console');
  });

  test('createConsoleLogger returns a new instance each time', () => {
    const loggerA = createConsoleLogger({ metadata });
    const loggerB = createConsoleLogger({ metadata });

    expect(loggerA).not.toBe(loggerB);
  });

  test('getConsoleLogger returns a singleton instance', () => {
    const loggerA = getConsoleLogger({ metadata });
    const loggerB = getConsoleLogger({
      metadata: {
        service: 'different',
        version: '2.0.0',
        environment: 'prod',
      },
    });

    expect(loggerA).toBe(loggerB);
  });

  test('commit logs trace batch summary and returns no failed traces', async () => {
    const logger = createConsoleLogger({ metadata });
    const logs: string[] = [];
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map((part) => String(part)).join(' '));
    };

    const failed = await logger.commit([makeTrace('trace-1', 2), makeTrace('trace-2', 1)]);

    expect(failed).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('msg=trace-batch');
    expect(logs[0]).toContain('count=2');
    expect(logs[0]).toContain('spans=3');
    expect(logs[0]).toContain('service=api');
    expect(logs[0]).toContain('version=1.0.0');
    expect(logs[0]).toContain('environment=test');
  });

  test('commit with empty array logs count=0 and spans=0 and returns []', async () => {
    const logger = createConsoleLogger({ metadata });
    const logs: string[] = [];
    console.log = (...parts: unknown[]) => {
      logs.push(parts.map((part) => String(part)).join(' '));
    };

    const failed = await logger.commit([]);

    expect(failed).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('msg=trace-batch');
    expect(logs[0]).toContain('count=0');
    expect(logs[0]).toContain('spans=0');
  });
});
