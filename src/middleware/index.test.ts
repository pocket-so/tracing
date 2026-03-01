import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import type { Context, Env } from 'hono';

import type { Logger, TraceSnapshot } from '@/types';
import type { WithTracingEnv } from './index';

import { getTracer, resetTracerForTests, tracing } from './index';
import { resetIsolateInstanceForTests } from './isolate';

type TracingOptions = Parameters<typeof tracing>[0];
type TestEnv = WithTracingEnv<Env>;
type MockLogger = Logger & {
  receivedBatches: Array<Array<TraceSnapshot>>;
};

const createMockLogger = (): MockLogger => {
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

const flushTracer = async (): Promise<void> => {
  const activeTracer = getTracer();
  if (!activeTracer) return;
  await activeTracer.dispose();
};

const buildApp = (
  options: TracingOptions,
  configureRoutes: (app: Hono<TestEnv>) => void,
  onError?: (
    error: Error,
    context: Context<TestEnv>,
  ) => Response | Promise<Response>,
): Hono<TestEnv> => {
  const app = new Hono<TestEnv>();
  app.onError(onError ?? ((error, context) => context.text(error.message, 500)));
  app.use('*', tracing(options));
  configureRoutes(app);
  return app;
};

const extractSingleSnapshot = (logger: MockLogger): TraceSnapshot => {
  expect(logger.receivedBatches).toHaveLength(1);
  const batch = logger.receivedBatches[0];
  expect(batch).toBeDefined();
  expect(batch).toHaveLength(1);

  const snapshot = batch?.[0];
  expect(snapshot).toBeDefined();
  if (!snapshot) throw new Error('Missing expected trace snapshot.');
  return snapshot;
};

const flattenTraceIds = (logger: MockLogger): Array<string> =>
  logger.receivedBatches.flat().map((trace) => trace.id).toSorted();

beforeEach(() => {
  resetTracerForTests();
  resetIsolateInstanceForTests();
});

afterEach(async () => {
  await flushTracer();
  resetTracerForTests();
  resetIsolateInstanceForTests();
});

describe('middleware/tracing', () => {
  test('getTracer lifecycle: null before middleware setup and instance after setup', async () => {
    const logger = createMockLogger();
    expect(getTracer()).toBeNull();

    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/lifecycle', (context) => context.text('ok'));
      },
    );
    expect(getTracer()).not.toBeNull();

    const response = await app.request('http://example.test/lifecycle');
    expect(response.status).toBe(200);
    expect(getTracer()).not.toBeNull();

    await flushTracer();
    expect(logger.receivedBatches).toHaveLength(1);
  });

  test('sets tracing context variables and tracing headers', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/context', (context) => {
          const trace = context.get('trace');
          const requestSpan = context.get('requestSpan');
          const isolate = context.get('isolate');

          return context.json({
            traceId: trace.id,
            spanId: requestSpan.id,
            isolateId: isolate.id,
            isolateRequests: isolate.requests,
          });
        });
      },
    );

    const response = await app.request('http://example.test/context');
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      traceId: string;
      spanId: string;
      isolateId: string;
      isolateRequests: number;
    };
    expect(response.headers.get('X-Trace-Id')).toBe(payload.traceId);
    expect(response.headers.get('X-Isolate-Id')).toBe(payload.isolateId);
    expect(response.headers.get('X-Isolate-Requests')).toBe(
      payload.isolateRequests.toString(),
    );

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    expect(snapshot.id).toBe(payload.traceId);
    expect(snapshot.spans[0]?.id).toBe(payload.spanId);
  });

  test('honors incoming default trace header', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/incoming', (context) => context.text('ok'));
      },
    );

    const response = await app.request('http://example.test/incoming', {
      headers: {
        'X-Trace-Id': 'incoming-trace-id',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Trace-Id')).toBe('incoming-trace-id');

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    expect(snapshot.id).toBe('incoming-trace-id');
  });

  test('supports custom trace header name', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        headerName: 'X-Correlation-Id',
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/custom-header', (context) => context.text('ok'));
      },
    );

    const response = await app.request('http://example.test/custom-header', {
      headers: {
        'X-Correlation-Id': 'corr-123',
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('X-Correlation-Id')).toBe('corr-123');
    expect(response.headers.get('X-Trace-Id')).toBeNull();

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    expect(snapshot.id).toBe('corr-123');
  });

  test('applies custom spanName to request span', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        spanName: 'request-custom',
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/span-name', (context) => context.text('ok'));
      },
    );

    const response = await app.request('http://example.test/span-name');
    expect(response.status).toBe(200);

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    expect(snapshot.spans[0]?.name).toBe('request-custom');
  });

  test('records expected request and response attributes', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.post('/attrs/:id', (context) => {
          context.status(201);
          return context.text('created');
        });
      },
    );

    const url = 'http://example.test/attrs/42?expand=1';
    const response = await app.request(url, {
      method: 'POST',
      headers: {
        host: 'api.test:8080',
        'user-agent': 'trace-agent',
      },
    });

    expect(response.status).toBe(201);

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    const span = snapshot.spans[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(span.attributes[ATTR_HTTP_REQUEST_METHOD]).toBe('POST');
    expect(span.attributes[ATTR_HTTP_ROUTE]).toBe('/attrs/:id');
    expect(span.attributes[ATTR_URL_FULL]).toBe(url);
    expect(span.attributes[ATTR_SERVER_ADDRESS]).toBe('api.test');
    expect(span.attributes[ATTR_SERVER_PORT]).toBe(8080);
    expect(span.attributes[ATTR_USER_AGENT_ORIGINAL]).toBe('trace-agent');
    expect(span.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(201);
    expect(typeof span.attributes['isolate.id']).toBe('string');
    expect(span.attributes['isolate.requests']).toBe(1);
  });

  test('omits optional host and user-agent attributes when missing', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/optional', (context) => context.text('ok'));
      },
    );

    const response = await app.request('/optional');
    expect(response.status).toBe(200);

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    const span = snapshot.spans[0];
    expect(span).toBeDefined();
    if (!span) return;

    expect(Object.hasOwn(span.attributes, ATTR_SERVER_ADDRESS)).toBe(false);
    expect(Object.hasOwn(span.attributes, ATTR_SERVER_PORT)).toBe(false);
    expect(Object.hasOwn(span.attributes, ATTR_USER_AGENT_ORIGINAL)).toBe(false);
  });

  test('ignore legacy array performs exact matching only', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        ignore: ['/skip'],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/skip', (context) => context.text('skip'));
        hono.get('/skip/nested', (context) => context.text('nested'));
      },
    );

    const skipResponse = await app.request('http://example.test/skip', {
      headers: { 'X-Trace-Id': 'skip-id' },
    });
    expect(skipResponse.status).toBe(200);
    expect(skipResponse.headers.get('X-Trace-Id')).toBeNull();

    const nestedResponse = await app.request('http://example.test/skip/nested', {
      headers: { 'X-Trace-Id': 'nested-id' },
    });
    expect(nestedResponse.status).toBe(200);
    expect(nestedResponse.headers.get('X-Trace-Id')).toBe('nested-id');

    await flushTracer();
    expect(flattenTraceIds(logger)).toEqual(['nested-id']);
  });

  test('ignore exact=true only skips exact path', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        ignore: {
          exact: true,
          list: ['/openapi'],
        },
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/openapi', (context) => context.text('openapi'));
        hono.get('/openapi/spec', (context) => context.text('spec'));
      },
    );

    const exactResponse = await app.request('http://example.test/openapi', {
      headers: { 'X-Trace-Id': 'openapi-id' },
    });
    expect(exactResponse.status).toBe(200);
    expect(exactResponse.headers.get('X-Trace-Id')).toBeNull();

    const nestedResponse = await app.request('http://example.test/openapi/spec', {
      headers: { 'X-Trace-Id': 'spec-id' },
    });
    expect(nestedResponse.status).toBe(200);
    expect(nestedResponse.headers.get('X-Trace-Id')).toBe('spec-id');

    await flushTracer();
    expect(flattenTraceIds(logger)).toEqual(['spec-id']);
  });

  test('ignore exact=false skips nested paths but traces non-matching routes', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        ignore: {
          exact: false,
          list: ['/openapi'],
        },
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/openapi', (context) => context.text('openapi'));
        hono.get('/openapi/spec', (context) => context.text('spec'));
        hono.get('/health', (context) => context.text('ok'));
      },
    );

    const openapiResponse = await app.request('http://example.test/openapi', {
      headers: { 'X-Trace-Id': 'openapi-id' },
    });
    expect(openapiResponse.headers.get('X-Trace-Id')).toBeNull();

    const specResponse = await app.request('http://example.test/openapi/spec', {
      headers: { 'X-Trace-Id': 'spec-id' },
    });
    expect(specResponse.headers.get('X-Trace-Id')).toBeNull();

    const healthResponse = await app.request('http://example.test/health', {
      headers: { 'X-Trace-Id': 'health-id' },
    });
    expect(healthResponse.status).toBe(200);
    expect(healthResponse.headers.get('X-Trace-Id')).toBe('health-id');

    await flushTracer();
    expect(flattenTraceIds(logger)).toEqual(['health-id']);
  });

  test('finalizes trace when route throws and captures status from context', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/boom', (context) => {
          context.status(503);
          throw new Error('boom');
        });
      },
      (_error, context) => context.text('failed', 503),
    );

    const response = await app.request('http://example.test/boom', {
      headers: { 'X-Trace-Id': 'boom-trace-id' },
    });
    expect(response.status).toBe(503);

    await flushTracer();
    const snapshot = extractSingleSnapshot(logger);
    const span = snapshot.spans[0];
    expect(snapshot.id).toBe('boom-trace-id');
    expect(span?.attributes[ATTR_HTTP_RESPONSE_STATUS_CODE]).toBe(503);
  });

  test('invalid host port fails request and does not commit traces', async () => {
    const logger = createMockLogger();
    const app = buildApp(
      {
        loggers: [logger],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/invalid-port', (context) => context.text('ok'));
      },
    );

    const response = await app.request('http://example.test/invalid-port', {
      headers: {
        host: 'example.test:abc',
      },
    });
    const body = await response.text();
    expect(response.status).toBe(500);
    expect(body.includes('Invalid port number')).toBe(true);
    expect(response.headers.get('X-Trace-Id')).toBeNull();

    await flushTracer();
    expect(logger.receivedBatches).toHaveLength(0);
  });

  test('reuses singleton tracer across apps and keeps first logger config', async () => {
    const loggerA = createMockLogger();
    const loggerB = createMockLogger();

    const appA = buildApp(
      {
        loggers: [loggerA],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/one', (context) => context.text('one'));
      },
    );
    expect(getTracer()).not.toBeNull();

    const firstResponse = await appA.request('http://example.test/one', {
      headers: { 'X-Trace-Id': 'trace-one' },
    });
    expect(firstResponse.status).toBe(200);

    const tracerAfterFirstRequest = getTracer();
    expect(tracerAfterFirstRequest).not.toBeNull();

    const appB = buildApp(
      {
        loggers: [loggerB],
        threshold: 1,
        interval: 30_000,
      },
      (hono) => {
        hono.get('/two', (context) => context.text('two'));
      },
    );

    expect(getTracer()).toBe(tracerAfterFirstRequest);

    const secondResponse = await appB.request('http://example.test/two', {
      headers: { 'X-Trace-Id': 'trace-two' },
    });
    expect(secondResponse.status).toBe(200);

    await flushTracer();
    expect(flattenTraceIds(loggerA)).toEqual(['trace-one', 'trace-two']);
    expect(loggerB.receivedBatches).toHaveLength(0);
  });
});
