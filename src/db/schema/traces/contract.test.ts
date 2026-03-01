import { describe, expect, test } from 'bun:test';

import type { InsertTrace } from './db';

import { TraceSchema } from './zod';

const traceInsertFixture = {
  traceId: 'c'.repeat(32),
  spanId: 'd'.repeat(16),
  parentSpanId: null,
  startTime: new Date('2026-01-28T12:00:00.000Z'),
  endTime: new Date('2026-01-28T12:00:00.120Z'),
  durationMs: 120,
  attributes: {
    'http.method': 'GET',
    retries: 1,
    sampled: true,
  },
  exceptionType: null,
  exceptionMessage: null,
  exceptionStacktrace: null,
  httpMethod: 'GET',
  httpRoute: '/health',
  httpStatusCode: 200,
  httpUrl: 'https://api.example.com/health',
  httpHost: 'api.example.com',
  httpUserAgent: 'trace-agent',
  service: 'api',
  version: '1.0.0',
  environment: 'test',
} satisfies InsertTrace;

describe('db/schema/traces/contract', () => {
  test('InsertTrace fixture is accepted by TraceSchema', () => {
    const result = TraceSchema.safeParse(traceInsertFixture);
    expect(result.success).toBe(true);
  });
});
