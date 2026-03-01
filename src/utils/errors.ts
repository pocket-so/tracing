import { SpanStatusCode } from '@opentelemetry/api';
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';

import type { SpanAttributeValue, TraceSnapshot } from '@/types';

interface ErrorInfo {
  type?: string;
  message?: string;
  stack?: string;
}

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const primitiveToMessage = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  switch (typeof value) {
    case 'string': {
      return value.length > 0 ? value : undefined;
    }
    case 'number':
    case 'boolean':
    case 'bigint': {
      return String(value);
    }
    case 'symbol': {
      return value.toString();
    }
    default: {
      return undefined;
    }
  }
};

export const extractErrorInfo = (err: unknown): ErrorInfo => {
  if (err instanceof Error) {
    const type = nonEmptyString(err.name) ?? 'Error';
    const message = nonEmptyString(err.message);
    const stack = nonEmptyString(err.stack);
    return { type, message, stack };
  }

  if (err && typeof err === 'object') {
    const maybe = err as { name?: unknown; message?: unknown; stack?: unknown };
    const message = nonEmptyString(maybe.message);
    const type = nonEmptyString(maybe.name) ?? (message ? 'Error' : undefined);
    const stack = nonEmptyString(maybe.stack);
    return { type, message, stack };
  }

  const message = primitiveToMessage(err);
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
