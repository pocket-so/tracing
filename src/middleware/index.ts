import type { Env, MiddlewareHandler } from 'hono';

import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  ATTR_URL_FULL,
  ATTR_USER_AGENT_ORIGINAL,
} from '@opentelemetry/semantic-conventions';
import { routePath } from 'hono/route';

import type { Logger, Span, Trace, Tracer } from '@/types';

import { createTracer } from '@/middleware/tracer';
import { parsePort } from '@/utils/parser';

import type { Isolate } from './isolate';

import { getOrCreateIsolateInstance } from './isolate';

/**
 * Routes to skip tracing. When exact is true (default), only paths in list are
 * matched exactly. When false, each list entry matches that path and any nested
 * subpath (e.g. '/openapi' matches '/openapi', '/openapi/spec').
 */
export interface IgnoreOptions {
  /** Match only exact paths (default true). If false, match path prefix + nested. */
  exact?: boolean;
  /** Paths to ignore. */
  list: Array<string>;
}

interface TracingMiddlewareOptions {
  /** Array of loggers to use */
  loggers?: Array<Logger>;
  /** Custom trace ID header name */
  headerName?: string;
  /** Custom request span name */
  spanName?: string;
  /** Routes to ignore. Object with exact (default true) and list, or legacy array (exact match). */
  ignore?: IgnoreOptions | Array<string>;
  /** Tracer configuration */
  interval?: number;
  /** Commit threshold */
  threshold?: number;
  /** Batch size */
  batchSize?: number;
  /** Max pending traces */
  maxPendingTraces?: number;
  /** Error callback */
  onError?: (error?: Error) => void | undefined;
  /** Debug mode */
  debug?: boolean;
}

export interface TracingVariables {
  trace: Trace;
  requestSpan: Span;
  isolate: Isolate;
}

export interface TracingEnv {
  Variables: TracingVariables;
}

/**
 * Type to wrap AppBindings in Hono with
 */
export type WithTracingEnv<E extends Env> = E & TracingEnv;

type IgnoreOption = IgnoreOptions | Array<string>;

/**
 * Builds a function that returns true when the request path should skip tracing.
 * Normalizes legacy array form to { exact: true, list }.
 *
 * @param ignore - Ignore option (object with exact + list, or array for exact match).
 * @returns Matcher (path) => boolean; never throws, returns false when ignore is empty/absent.
 */
const createIgnoreMatcher = (
  ignore: IgnoreOption | undefined,
): ((path: string) => boolean) => {
  if (!ignore) return () => false;
  const exact = Array.isArray(ignore) ? true : (ignore.exact ?? true);
  const list = Array.isArray(ignore) ? ignore : ignore.list;
  if (list.length === 0) return () => false;
  if (exact) {
    const set = new Set(list);
    return (path) => set.has(path);
  }
  return (path) => list.some((p) => path === p || path.startsWith(`${p}/`));
};

/** Cached tracer instance */
let tracer: Tracer | null = null;

/** Test helper to reset tracer singleton state between unit tests. */
export const resetTracerForTests = (): void => {
  tracer = null;
};

/**
 * Returns the tracer instance used by the tracing middleware, if any.
 * Use this to call `dispose()` for graceful shutdown (flush pending traces).
 *
 * @returns The current tracer, or null if tracing middleware has not been used yet.
 */
export const getTracer = (): Tracer | null => tracer;

/**
 * Hono middleware that creates a trace + request span and attaches them to context.
 *
 * @param options - Options:
 * - loggers: Array of logger instances
 * - headerName: trace id header (default: "X-Trace-Id")
 * - spanName: request span name (default: "http-request")
 * - ignore: { exact?: boolean, list: string[] } (exact default true) or legacy string[] (exact)
 * - interval: commit interval in ms (default: 10000)
 * - threshold: commit threshold (default: 100)
 * - batchSize: max traces per commit (default: 100)
 * - maxPendingTraces: max queued traces before eviction (default: 10000)
 * - onError: error callback (default: undefined)
 * - debug: enable debug logging (default: false)
 */
export const tracing = <E extends Env>(
  options: TracingMiddlewareOptions = {},
): MiddlewareHandler<WithTracingEnv<E>> => {
  const headerName = options.headerName ?? 'X-Trace-Id';
  const spanName = options.spanName ?? 'http-request';
  const ignoreMatcher = createIgnoreMatcher(options.ignore);

  const currentTracer =
    tracer ??
    createTracer({
      loggers: options.loggers ?? [],
      interval: options.interval,
      threshold: options.threshold,
      batchSize: options.batchSize,
      maxPendingTraces: options.maxPendingTraces,
      onError: options.onError,
      debug: options.debug,
    });
  tracer = currentTracer;

  return async (context, next) => {
    if (ignoreMatcher(context.req.path)) {
      await next();
      return;
    }

    const incomingId = context.req.header(headerName);
    const trace = currentTracer.startTrace({ id: incomingId });

    const host = context.req.header('host');
    const agent = context.req.header('user-agent');
    const route = routePath(context, -1);

    const hostParts = host ? host.split(':') : [];
    const hostName = hostParts[0] ?? undefined;
    const hostPort = parsePort(hostParts[1]);

    const isolateInstance = getOrCreateIsolateInstance();

    const span = trace.startSpan({
      name: spanName,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: context.req.method,
        [ATTR_HTTP_ROUTE]: route,
        [ATTR_URL_FULL]: context.req.url,
        ...(hostName ? { [ATTR_SERVER_ADDRESS]: hostName } : {}),
        ...(Number.isFinite(hostPort) ? { [ATTR_SERVER_PORT]: hostPort } : {}),
        ...(agent ? { [ATTR_USER_AGENT_ORIGINAL]: agent } : {}),
        'isolate.id': isolateInstance.id,
        'isolate.requests': isolateInstance.requests,
      },
    });

    context.header('X-Isolate-Id', isolateInstance.id);
    context.header('X-Isolate-Requests', isolateInstance.requests.toString());
    context.set('isolate', isolateInstance);

    context.header(headerName, trace.id);
    context.set('trace', trace);
    context.set('requestSpan', span);

    try {
      await next();
    } finally {
      span.setAttributes({
        [ATTR_HTTP_RESPONSE_STATUS_CODE]: context.res.status,
      });

      span.stop();
      trace.finish();
    }
  };
};
