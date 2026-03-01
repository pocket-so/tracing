import { ExportResultCode } from '@opentelemetry/core';
import { ATTR_EXCEPTION_MESSAGE } from '@opentelemetry/semantic-conventions';
import { describe, expect, test } from 'bun:test';

import type { TraceSnapshot } from '@/types';

import { createSentryLogger, getSentryLogger } from './index';

const metadata = {
  service: 'api',
  version: '1.0.0',
  environment: 'test',
} as const;

const config = {
  endpoint: 'https://example.ingest.sentry.io/api/0/otlp/v1/traces',
  token: 'test-token',
  metadata,
} as const;

const makeTrace = (
  spans: TraceSnapshot['spans'],
): TraceSnapshot => ({
  id: 'trace-1',
  startTime: 0,
  endTime: 1,
  duration: 1,
  spans,
});

const makeSpan = (
  id: string,
  attributes: Record<string, string | number | boolean> = {},
): TraceSnapshot['spans'][number] => ({
  id,
  traceId: 'trace-1',
  parentSpanId: null,
  name: 'http-request',
  startTime: 0,
  endTime: 1,
  duration: 1,
  attributes,
});

const createMockExporter = (
  onExport: (spans: unknown[], done: (code: ExportResultCode, error?: Error) => void) => void,
) => ({
  export: (
    spans: unknown[],
    callback: (result: { code: ExportResultCode; error?: Error }) => void,
  ) => {
    onExport(spans, (code, error) => callback({ code, error }));
  },
  shutdown: (): Promise<void> => Promise.resolve(),
});

describe('loggers/sentry', () => {
  test('createSentryLogger has id "sentry"', () => {
    expect(createSentryLogger(config).id).toBe('sentry');
  });

  test('createSentryLogger returns a new instance each time', () => {
    const loggerA = createSentryLogger(config);
    const loggerB = createSentryLogger(config);

    expect(loggerA).not.toBe(loggerB);
  });

  test('getSentryLogger returns a singleton instance', () => {
    const loggerA = getSentryLogger(config);
    const loggerB = getSentryLogger({
      endpoint: 'https://different',
      token: 'different',
      metadata: {
        service: 'different',
        version: '2.0.0',
        environment: 'prod',
      },
    });

    expect(loggerA).toBe(loggerB);
  });

  test('commit skips export when no error spans exist', async () => {
    let exportCalls = 0;
    const logger = createSentryLogger({
      ...config,
      exporter: createMockExporter((_spans, done) => {
        exportCalls += 1;
        done(ExportResultCode.SUCCESS);
      }),
    });

    const failed = await logger.commit([makeTrace([makeSpan('span-1', { ok: true })])]);

    expect(failed).toEqual([]);
    expect(exportCalls).toBe(0);
  });

  test('commit exports full trace when one span has an error', async () => {
    let receivedSpans: unknown[] = [];
    const logger = createSentryLogger({
      ...config,
      exporter: createMockExporter((spans, done) => {
        receivedSpans = spans;
        done(ExportResultCode.SUCCESS);
      }),
    });

    const failed = await logger.commit([
      makeTrace([
        makeSpan('span-1', { custom: 'value' }),
        makeSpan('span-2', {
          error: true,
          [ATTR_EXCEPTION_MESSAGE]: 'boom',
        }),
      ]),
    ]);

    expect(failed).toEqual([]);
    expect(receivedSpans).toHaveLength(2);
    expect(
      (receivedSpans[1] as { attributes: Record<string, unknown> }).attributes.error,
    ).toBeUndefined();
  });

  test('commit returns original traces and forwards exporter errors', async () => {
    const exportError = new Error('failed');
    let receivedError: Error | undefined = undefined;
    const logger = createSentryLogger({
      ...config,
      exporter: createMockExporter((_spans, done) => {
        done(ExportResultCode.FAILED, exportError);
      }),
    });

    const traces = [
      makeTrace([makeSpan('span-1', { [ATTR_EXCEPTION_MESSAGE]: 'boom' })]),
    ];
    const failed = await logger.commit(traces, (error) => {
      receivedError = error;
    });

    expect(failed).toBe(traces);
    expect(receivedError).toBeDefined();
    expect((receivedError as Error | undefined)?.message).toBe('failed');
  });
});
