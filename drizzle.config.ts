import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/traces/db.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.TIMESCALE_DATABASE_URL!,
  },
});
