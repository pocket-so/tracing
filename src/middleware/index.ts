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

interface TracingMiddlewareOptions {
  /** Array of loggers to use */
  loggers?: Array<Logger>;
  /** Custom trace ID header name */
  headerName?: string;
  /** Custom request span name */
  spanName?: string;
  /** Routes to ignore (exact path match) */
  ignore?: Array<string>;
  /** Tracer configuration */
  interval?: number;
  threshold?: number;
  batchSize?: number;
  maxPendingTraces?: number;
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

/** Cached tracer instance */
let tracer: Tracer | null = null;

/**
 * Hono middleware that creates a trace + request span and attaches them to context.
 *
 * @param options - Options:
 * - loggers: Array of logger instances
 * - headerName: trace id header (default: "X-Trace-Id")
 * - spanName: request span name (default: "http-request")
 * - ignore: array of routes to skip tracing (exact match)
 * - interval: commit interval in ms (default: 10000)
 * - threshold: commit threshold (default: 100)
 * - batchSize: max traces per commit (default: 100)
 * - maxPendingTraces: max queued traces before eviction (default: 10000)
 * - debug: enable debug logging (default: false)
 */
export const tracing = <E extends Env>(
  options: TracingMiddlewareOptions = {},
): MiddlewareHandler<WithTracingEnv<E>> => {
  const headerName = options.headerName ?? 'X-Trace-Id';
  const spanName = options.spanName ?? 'http-request';
  const ignore = options.ignore ? new Set(options.ignore) : null;

  const currentTracer =
    tracer ??
    createTracer({
      loggers: options.loggers ?? [],
      interval: options.interval,
      threshold: options.threshold,
      batchSize: options.batchSize,
      maxPendingTraces: options.maxPendingTraces,
      debug: options.debug,
    });
  tracer = currentTracer;

  return async (context, next) => {
    if (ignore?.has(context.req.path)) {
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
