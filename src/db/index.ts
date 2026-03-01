import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// oxlint-disable-next-line import/no-namespace - required for drizzle
import * as schema from '@/db/schema/traces/db';

export const createTimescaleClient = (url: string) =>
  drizzle({
    schema,
    client: postgres(url, {
      max: 5,
      fetch_types: false,
    }),
  });

export type Timescale = ReturnType<typeof drizzle<typeof schema>>;
