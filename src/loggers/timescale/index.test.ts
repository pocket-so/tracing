import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  ATTR_HTTP_REQUEST_HEADER,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_URL_FULL,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import { describe, expect, test } from 'bun:test';

import type { InsertTrace } from '@/db/schema/traces/db';
import type { Timescale } from '@/db';
import type { TraceSnapshot } from '@/types';

import { createTimescaleLogger, getTimescaleLogger } from './index';

const metadata = {
  service: 'api',
  version: '1.0.0',
  environment: 'test',
} as const;

// oxlint-disable-next-line new-cap -- required to match OTLP header key helper.
const hostHeaderKey = ATTR_HTTP_REQUEST_HEADER('host');

const makeSpan = (
  id: string,
  attributes: Record<string, string | number | boolean> = {},
): TraceSnapshot['spans'][number] => ({
  id,
  traceId: 'trace-1',
  parentSpanId: null,
  name: 'http-request',
  startTime: 1_000,
  endTime: 1_500,
  duration: 500,
  attributes,
});

const makeTrace = (
  id: string,
  spans: TraceSnapshot['spans'],
): TraceSnapshot => ({
  id,
  startTime: 1_000,
  endTime: 1_500,
  duration: 500,
  spans,
});

const createDbMock = (options: { shouldFail?: boolean } = {}) => {
  const calls: Array<Array<InsertTrace>> = [];
  const error = new Error('insert failed');

  const db = {
    insert: () => ({
      values: async (rows: Array<InsertTrace>) => {
        if (options.shouldFail) {
          throw error;
        }
        calls.push([...rows]);
      },
    }),
  } as unknown as Timescale;

  return { db, calls, error };
};

describe('loggers/timescale', () => {
  test('createTimescaleLogger has id "timescale"', () => {
    const { db } = createDbMock();
    expect(createTimescaleLogger({ metadata, db }).id).toBe('timescale');
  });

  test('createTimescaleLogger returns a new instance each time', () => {
    const { db } = createDbMock();
    const loggerA = createTimescaleLogger({ metadata, db });
    const loggerB = createTimescaleLogger({ metadata, db });

    expect(loggerA).not.toBe(loggerB);
  });

  test('getTimescaleLogger returns a singleton instance', () => {
    const { db } = createDbMock();
    const loggerA = getTimescaleLogger({ metadata, db });
    const loggerB = getTimescaleLogger({
      metadata: {
        service: 'different',
        version: '2.0.0',
        environment: 'prod',
      },
      db,
    });

    expect(loggerA).toBe(loggerB);
  });

  test('commit inserts rows in batches and maps special attributes', async () => {
    const { db, calls } = createDbMock();
    const logger = createTimescaleLogger({
      metadata,
      db,
      batchSize: 2,
    });

    const traces = [
      makeTrace('trace-1', [
        makeSpan('span-1', {
          custom: 'value-1',
          [ATTR_EXCEPTION_TYPE]: 'TypeError',
          [ATTR_EXCEPTION_MESSAGE]: 'boom',
          [ATTR_EXCEPTION_STACKTRACE]: 'stack',
          [ATTR_HTTP_REQUEST_METHOD]: 'GET',
          [ATTR_HTTP_ROUTE]: '/v1/items',
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500,
          [ATTR_URL_FULL]: 'https://api.example.dev/v1/items',
          [ATTR_SERVER_ADDRESS]: 'api.example.dev',
          [ATTR_USER_AGENT_ORIGINAL]: 'test-agent',
          [hostHeaderKey]: 'duplicate-host',
        }),
        makeSpan('span-2', { custom: 'value-2' }),
      ]),
      makeTrace('trace-2', [makeSpan('span-3', { custom: 'value-3' })]),
    ];

    const failed = await logger.commit(traces);

    expect(failed).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(2);
    expect(calls[1]).toHaveLength(1);

    const firstRow = calls[0]![0]!;
    expect(firstRow.traceId).toBe('trace-1');
    expect(firstRow.spanId).toBe('span-1');
    expect(firstRow.exceptionType).toBe('TypeError');
    expect(firstRow.exceptionMessage).toBe('boom');
    expect(firstRow.exceptionStacktrace).toBe('stack');
    expect(firstRow.httpMethod).toBe('GET');
    expect(firstRow.httpRoute).toBe('/v1/items');
    expect(firstRow.httpStatusCode).toBe(500);
    expect(firstRow.httpUrl).toBe('https://api.example.dev/v1/items');
    expect(firstRow.httpHost).toBe('api.example.dev');
    expect(firstRow.httpUserAgent).toBe('test-agent');
    expect(firstRow.service).toBe('api');
    expect(firstRow.version).toBe('1.0.0');
    expect(firstRow.environment).toBe('test');
    const firstAttrs = firstRow.attributes as Record<string, unknown>;
    expect(firstAttrs.custom).toBe('value-1');
    expect(firstAttrs[ATTR_EXCEPTION_TYPE]).toBeUndefined();
    expect(firstAttrs[ATTR_HTTP_REQUEST_METHOD]).toBeUndefined();
    expect(firstAttrs[ATTR_URL_FULL]).toBeUndefined();
    expect(firstAttrs[hostHeaderKey]).toBeUndefined();
  });

  test('commit returns [] when no traces (empty array)', async () => {
    const { db, calls } = createDbMock();
    const logger = createTimescaleLogger({ metadata, db });

    const failed = await logger.commit([]);

    expect(failed).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('commit returns [] when all traces are empty', async () => {
    const { db, calls } = createDbMock();
    const logger = createTimescaleLogger({ metadata, db });

    const failed = await logger.commit([
      { id: 'trace-empty', startTime: 0, endTime: 1, duration: 1, spans: [] },
    ]);

    expect(failed).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test('commit returns original traces and forwards insert errors', async () => {
    const { db, error } = createDbMock({ shouldFail: true });
    const logger = createTimescaleLogger({
      metadata,
      db,
      batchSize: 1,
    });
    const traces = [makeTrace('trace-1', [makeSpan('span-1', { custom: true })])];
    let receivedError: Error | undefined = undefined;

    const failed = await logger.commit(traces, (insertError) => {
      receivedError = insertError;
    });

    expect(failed).toBe(traces);
    expect(receivedError).toBeDefined();
    expect((receivedError as Error | undefined)?.message).toBe(error.message);
  });
});
