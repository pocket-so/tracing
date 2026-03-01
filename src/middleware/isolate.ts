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
