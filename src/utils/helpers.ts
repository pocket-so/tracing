import type { Context, Env } from 'hono';

import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';

import type { WithTracingEnv } from '@/middleware';
import type { Span } from '@/types';

import { extractErrorInfo } from '@/utils/errors';

/**
 * Attach OpenTelemetry-style error attributes to a span.
 *
 * @param span - Target span.
 * @param err - Error or unknown value to record.
 */
export const setSpanError = (span: Span, err: unknown): void => {
  const { type, message, stack } = extractErrorInfo(err);
  span.setAttributes({
    [ATTR_EXCEPTION_TYPE]: type,
    [ATTR_EXCEPTION_MESSAGE]: message,
    [ATTR_EXCEPTION_STACKTRACE]: stack,
  });
};

/**
 * Get the active trace from a Hono context created by tracingMiddleware.
 */
export const getTrace = <E extends Env>(context: Context<WithTracingEnv<E>>) =>
  context.get('trace');

/**
 * Get the request span from a Hono context created by tracingMiddleware.
 */
export const getRequestSpan = <E extends Env>(context: Context<WithTracingEnv<E>>) =>
  context.get('requestSpan');
