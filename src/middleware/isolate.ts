import { v7 as uuidv7 } from 'uuid';

export interface Isolate {
  id: string;
  requests: number;
}

let instance: Isolate | null = null;

export const getOrCreateIsolateInstance = (): Isolate => {
  instance = instance ?? {
    id: uuidv7(),
    requests: 0,
  };
  instance.requests++;

  return instance;
};

/** Test helper to reset isolate singleton state between unit tests. */
export const resetIsolateInstanceForTests = (): void => {
  instance = null;
};
