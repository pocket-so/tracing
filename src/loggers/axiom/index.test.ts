import { ExportResultCode } from '@opentelemetry/core';
import { ATTR_EXCEPTION_STACKTRACE } from '@opentelemetry/semantic-conventions';
import { describe, expect, test } from 'bun:test';

import type { TraceSnapshot } from '@/types';

import { createAxiomLogger, getAxiomLogger } from './index';

const metadata = {
  service: 'api',
  version: '1.0.0',
  environment: 'test',
} as const;

const config = {
  token: 'test-token',
  dataset: 'test-dataset',
  metadata,
} as const;

const makeTrace = (
  attributes: Record<string, string | number | boolean> = {},
): TraceSnapshot => ({
  id: 'trace-1',
  startTime: 0,
  endTime: 1,
  duration: 1,
  spans: [
    {
      id: 'span-1',
      traceId: 'trace-1',
      parentSpanId: null,
      name: 'http-request',
      startTime: 0,
      endTime: 1,
      duration: 1,
      attributes,
    },
  ],
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

describe('loggers/axiom', () => {
  test('createAxiomLogger has id "axiom"', () => {
    expect(createAxiomLogger(config).id).toBe('axiom');
  });

  test('createAxiomLogger returns a new instance each time', () => {
    const loggerA = createAxiomLogger(config);
    const loggerB = createAxiomLogger(config);

    expect(loggerA).not.toBe(loggerB);
  });

  test('getAxiomLogger returns a singleton instance', () => {
    const loggerA = getAxiomLogger(config);
    const loggerB = getAxiomLogger({
      token: 'different',
      dataset: 'different',
      metadata: {
        service: 'different',
        version: '2.0.0',
        environment: 'prod',
      },
    });

    expect(loggerA).toBe(loggerB);
  });

  test('commit returns [] and does not export when all traces are empty', async () => {
    let exportCalls = 0;
    const logger = createAxiomLogger({
      ...config,
      exporter: createMockExporter((_spans, done) => {
        exportCalls += 1;
        done(ExportResultCode.SUCCESS);
      }),
    });

    const failed = await logger.commit([
      { id: 'trace-empty', startTime: 0, endTime: 1, duration: 1, spans: [] },
    ]);

    expect(failed).toEqual([]);
    expect(exportCalls).toBe(0);
  });

  test('commit exports spans and removes error attribute', async () => {
    let receivedSpans: unknown[] = [];
    const logger = createAxiomLogger({
      ...config,
      includeStacktrace: true,
      stacktraceMaxLength: 5,
      exporter: createMockExporter((spans, done) => {
        receivedSpans = spans;
        done(ExportResultCode.SUCCESS);
      }),
    });

    const failed = await logger.commit([
      makeTrace({
        error: true,
        [ATTR_EXCEPTION_STACKTRACE]: '1234567',
        custom: 'value',
      }),
    ]);

    expect(failed).toEqual([]);
    expect(receivedSpans).toHaveLength(1);
    expect(
      (receivedSpans[0] as { attributes: Record<string, unknown> }).attributes.error,
    ).toBeUndefined();
    expect(
      (receivedSpans[0] as { attributes: Record<string, unknown> }).attributes[
        ATTR_EXCEPTION_STACKTRACE
      ],
    ).toBe('12345');
    expect(
      (receivedSpans[0] as { attributes: Record<string, unknown> }).attributes.custom,
    ).toBe('value');
  });

  test('commit strips stacktrace when includeStacktrace is false', async () => {
    let receivedSpans: unknown[] = [];
    const logger = createAxiomLogger({
      ...config,
      includeStacktrace: false,
      exporter: createMockExporter((spans, done) => {
        receivedSpans = spans;
        done(ExportResultCode.SUCCESS);
      }),
    });

    await logger.commit([
      makeTrace({
        [ATTR_EXCEPTION_STACKTRACE]: 'stack',
        custom: 'value',
      }),
    ]);

    expect(
      (receivedSpans[0] as { attributes: Record<string, unknown> }).attributes[
        ATTR_EXCEPTION_STACKTRACE
      ],
    ).toBeUndefined();
  });

  test('commit returns original traces and forwards exporter errors', async () => {
    const exportError = new Error('failed');
    let receivedError: Error | undefined = undefined;
    const logger = createAxiomLogger({
      ...config,
      exporter: createMockExporter((_spans, done) => {
        done(ExportResultCode.FAILED, exportError);
      }),
    });

    const traces = [makeTrace({ custom: 'value' })];
    const failed = await logger.commit(traces, (error) => {
      receivedError = error;
    });

    expect(failed).toBe(traces);
    expect(receivedError).toBeDefined();
    expect((receivedError as Error | undefined)?.message).toBe('failed');
  });
});
