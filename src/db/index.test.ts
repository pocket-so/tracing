import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

const postgresCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
const drizzleCalls: Array<{ client: unknown; schema: unknown }> = [];

const postgresClient = { type: 'postgres-client' };
const drizzleClient = { type: 'drizzle-client' };

const postgresMock = mock((url: string, options: Record<string, unknown>) => {
  postgresCalls.push({ url, options });
  return postgresClient;
});

const drizzleMock = mock((config: { client: unknown; schema: unknown }) => {
  drizzleCalls.push(config);
  return drizzleClient;
});

await mock.module('postgres', () => ({ default: postgresMock }));
await mock.module('drizzle-orm/postgres-js', () => ({ drizzle: drizzleMock }));

const { createTimescaleClient } = await import('./index');

afterEach(() => {
  postgresCalls.length = 0;
  drizzleCalls.length = 0;
  mock.clearAllMocks();
});

afterAll(() => {
  mock.restore();
});

describe('db/index', () => {
  test('createTimescaleClient wires postgres and drizzle with expected config', async () => {
    const tracesModule = await import('@/db/schema/traces/db');
    const db = createTimescaleClient('postgres://test:test@localhost:5432/tracing');

    expect(postgresCalls).toHaveLength(1);
    expect(postgresCalls[0]).toEqual({
      url: 'postgres://test:test@localhost:5432/tracing',
      options: {
        max: 5,
        fetch_types: false,
      },
    });

    expect(drizzleCalls).toHaveLength(1);
    expect(drizzleCalls[0]?.client).toBe(postgresClient);
    expect(drizzleCalls[0]?.schema).toMatchObject({ Traces: tracesModule.Traces });

    expect(db).toBe(drizzleClient as unknown as typeof db);
  });
});
