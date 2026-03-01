import { beforeEach, describe, expect, test } from 'bun:test';

import { getOrCreateIsolateInstance, resetIsolateInstanceForTests } from './isolate';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('middleware/isolate', () => {
  beforeEach(() => {
    resetIsolateInstanceForTests();
  });

  test('returns object with id and requests', () => {
    const first = getOrCreateIsolateInstance();

    expect(first).toBeDefined();
    expect(typeof first.id).toBe('string');
    expect(first.id).toMatch(UUID_REGEX);
    expect(first.requests).toBe(1);
  });

  test('returns same instance and increments requests on subsequent calls', () => {
    const first = getOrCreateIsolateInstance();
    const requestsAfterFirst = first.requests;
    const second = getOrCreateIsolateInstance();

    expect(second).toBe(first);
    expect(second.id).toBe(first.id);
    expect(second.requests).toBe(requestsAfterFirst + 1);
  });
});
