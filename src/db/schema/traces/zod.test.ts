import { describe, expect, test } from 'bun:test';

import { TraceSchema } from './zod';

const createValidTraceInput = () => ({
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  parentSpanId: null,
  startTime: '2026-01-28T12:00:00.000Z',
  endTime: new Date('2026-01-28T12:00:01.000Z'),
  durationMs: '120',
  attributes: {
    'http.method': 'GET',
    attempts: 2,
    sampled: true,
  },
  exceptionType: null,
  exceptionMessage: null,
  exceptionStacktrace: null,
  httpMethod: 'GET',
  httpRoute: '/v1/session',
  httpStatusCode: '200',
  httpUrl: 'https://api.example.com/v1/session',
  httpHost: 'api.example.com',
  httpUserAgent: 'trace-agent',
  service: 'api',
  version: '1.2.3',
  environment: 'test',
});

describe('db/schema/traces/zod', () => {
  test('parses valid root span payload and coerces dates/numbers', () => {
    const result = TraceSchema.safeParse(createValidTraceInput());

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.parentSpanId).toBeNull();
    expect(result.data.startTime).toBeInstanceOf(Date);
    expect(result.data.endTime).toBeInstanceOf(Date);
    expect(result.data.durationMs).toBe(120);
    expect(result.data.httpStatusCode).toBe(200);
  });

  test('rejects invalid traceId length', () => {
    const result = TraceSchema.safeParse({
      ...createValidTraceInput(),
      traceId: 'short',
    });

    expect(result.success).toBe(false);
  });

  test('rejects invalid spanId length', () => {
    const result = TraceSchema.safeParse({
      ...createValidTraceInput(),
      spanId: 'short',
    });

    expect(result.success).toBe(false);
  });

  test('rejects invalid non-null parentSpanId length', () => {
    const result = TraceSchema.safeParse({
      ...createValidTraceInput(),
      parentSpanId: 'short',
    });

    expect(result.success).toBe(false);
  });

  test('rejects nested object attribute values', () => {
    const result = TraceSchema.safeParse({
      ...createValidTraceInput(),
      attributes: {
        nested: { bad: true } as unknown,
      },
    });

    expect(result.success).toBe(false);
  });

  test('rejects array attribute values', () => {
    const result = TraceSchema.safeParse({
      ...createValidTraceInput(),
      attributes: {
        list: [1, 2, 3] as unknown,
      },
    });

    expect(result.success).toBe(false);
  });
});
