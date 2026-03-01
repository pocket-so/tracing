import { SpanStatusCode } from '@opentelemetry/api';
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from '@opentelemetry/semantic-conventions';
import { describe, expect, test } from 'bun:test';

import {
  extractErrorInfo,
  hasErrorAttributes,
  isErrorSpan,
  statusResolver,
} from './errors';

describe('utils/errors', () => {
  describe('extractErrorInfo', () => {
    test('Error instance returns name, message, stack', () => {
      const err = new Error('something broke');
      err.name = 'TypeError';
      const stack = err.stack;
      const got = extractErrorInfo(err);
      expect(got.type).toBe('TypeError');
      expect(got.message).toBe('something broke');
      expect(got.stack).toBe(stack);
    });

    test('Error with empty name falls back to "Error"', () => {
      const err = new Error('msg');
      err.name = '';
      expect(extractErrorInfo(err).type).toBe('Error');
    });

    test('object with name/message/stack returns them', () => {
      const err = {
        name: 'CustomError',
        message: 'custom',
        stack: 'at foo (bar.ts:1)',
      };
      const got = extractErrorInfo(err);
      expect(got.type).toBe('CustomError');
      expect(got.message).toBe('custom');
      expect(got.stack).toBe('at foo (bar.ts:1)');
    });

    test('object with only message gets type "Error"', () => {
      const got = extractErrorInfo({ message: 'only message' });
      expect(got.type).toBe('Error');
      expect(got.message).toBe('only message');
    });

    test('object with name but no message returns name as type', () => {
      const got = extractErrorInfo({ name: 'X' });
      expect(got.type).toBe('X');
      expect(got.message).toBeUndefined();
    });

    test('string primitive returns message only', () => {
      const got = extractErrorInfo('oops');
      expect(got.type).toBe('Error');
      expect(got.message).toBe('oops');
      expect(got.stack).toBeUndefined();
    });

    test('number primitive returns string message', () => {
      const got = extractErrorInfo(42);
      expect(got.message).toBe('42');
      expect(got.type).toBe('Error');
    });

    test('boolean and bigint primitives get string message', () => {
      expect(extractErrorInfo(true).message).toBe('true');
      expect(extractErrorInfo(1n).message).toBe('1');
    });

    test('symbol primitive uses toString() as message', () => {
      const got = extractErrorInfo(Symbol('sym'));
      expect(got.message).toBe('Symbol(sym)');
      expect(got.type).toBe('Error');
    });

    test('null and undefined return no type or message', () => {
      expect(extractErrorInfo(null)).toEqual({
        type: undefined,
        message: undefined,
        stack: undefined,
      });
      expect(extractErrorInfo(undefined)).toEqual({
        type: undefined,
        message: undefined,
        stack: undefined,
      });
    });

    test('empty string returns undefined message', () => {
      const got = extractErrorInfo('');
      expect(got.message).toBeUndefined();
      expect(got.type).toBeUndefined();
    });
  });

  describe('hasErrorAttributes', () => {
    test('returns true when exception.type is present', () => {
      expect(hasErrorAttributes({ 'exception.type': 'Error' })).toBe(true);
    });

    test('returns true when exception.message is present', () => {
      expect(hasErrorAttributes({ 'exception.message': 'failed' })).toBe(true);
    });

    test('returns true when exception.stacktrace is present', () => {
      expect(hasErrorAttributes({ 'exception.stacktrace': 'at foo' })).toBe(true);
    });

    test('returns true when http status is >= 500', () => {
      const attrs = { [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500 };
      expect(hasErrorAttributes(attrs)).toBe(true);
      expect(hasErrorAttributes({ [ATTR_HTTP_RESPONSE_STATUS_CODE]: 503 })).toBe(true);
    });

    test('returns false when http status is < 500', () => {
      expect(hasErrorAttributes({ [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200 })).toBe(false);
      expect(hasErrorAttributes({ [ATTR_HTTP_RESPONSE_STATUS_CODE]: 404 })).toBe(false);
    });

    test('returns false for empty attributes', () => {
      expect(hasErrorAttributes({})).toBe(false);
    });

    test('returns false when status is non-number', () => {
      expect(
        hasErrorAttributes({
          [ATTR_HTTP_RESPONSE_STATUS_CODE]: '500' as unknown as number,
        }),
      ).toBe(false);
    });
  });

  describe('isErrorSpan', () => {
    test('returns true when span has error attributes', () => {
      const span = {
        id: 's1',
        traceId: 't1',
        parentSpanId: null,
        name: 'http',
        startTime: 0,
        endTime: 1,
        duration: 1,
        attributes: { 'exception.message': 'err' },
      };
      expect(isErrorSpan(span)).toBe(true);
    });

    test('returns false when span has no error attributes', () => {
      const span = {
        id: 's1',
        traceId: 't1',
        parentSpanId: null,
        name: 'http',
        startTime: 0,
        endTime: 1,
        duration: 1,
        attributes: {},
      };
      expect(isErrorSpan(span)).toBe(false);
    });
  });

  describe('statusResolver', () => {
    test('returns ERROR code when span has error attributes', () => {
      const span = {
        id: 's1',
        traceId: 't1',
        parentSpanId: null,
        name: 'http',
        startTime: 0,
        endTime: 1,
        duration: 1,
        attributes: { 'exception.type': 'Error' },
      };
      expect(statusResolver(span)).toEqual({ code: SpanStatusCode.ERROR });
    });

    test('returns UNSET code when span has no error attributes', () => {
      const span = {
        id: 's1',
        traceId: 't1',
        parentSpanId: null,
        name: 'http',
        startTime: 0,
        endTime: 1,
        duration: 1,
        attributes: {},
      };
      expect(statusResolver(span)).toEqual({ code: SpanStatusCode.UNSET });
    });
  });
});
