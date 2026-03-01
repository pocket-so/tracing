import { SpanStatusCode } from '@opentelemetry/api';
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';

import type { SpanAttributeValue, TraceSnapshot } from '@/types';

import { coercePrimitive, pickString } from '@/utils/primitives';

interface ErrorInfo {
  type?: string;
  message?: string;
  stack?: string;
}

export const extractErrorInfo = (err: unknown): ErrorInfo => {
  if (err instanceof Error) {
    const type = pickString(err.name) ?? 'Error';
    const message = pickString(err.message);
    const stack = pickString(err.stack);
    return { type, message, stack };
  }

  if (err && typeof err === 'object') {
    const maybe = err as { name?: unknown; message?: unknown; stack?: unknown };
    const message = pickString(maybe.message);
    const type = pickString(maybe.name) ?? (message ? 'Error' : undefined);
    const stack = pickString(maybe.stack);
    return { type, message, stack };
  }

  const message = coercePrimitive(err);
  return {
    type: message ? 'Error' : undefined,
    message,
    stack: undefined,
  };
};

export const hasErrorAttributes = (
  attributes: Readonly<Record<string, SpanAttributeValue>>,
): boolean => {
  if (
    attributes['exception.type'] !== undefined ||
    attributes['exception.message'] !== undefined ||
    attributes['exception.stacktrace'] !== undefined
  ) {
    return true;
  }

  const status = attributes[ATTR_HTTP_RESPONSE_STATUS_CODE];
  return typeof status === 'number' && status >= 500;
};

export const isErrorSpan = (span: TraceSnapshot['spans'][number]): boolean =>
  hasErrorAttributes(span.attributes);

export const statusResolver = (span: TraceSnapshot['spans'][number]) =>
  isErrorSpan(span) ? { code: SpanStatusCode.ERROR } : { code: SpanStatusCode.UNSET };
