import {
  char,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const Traces = pgTable(
  'tracing_spans',
  {
    traceId: char('trace_id', { length: 32 }).notNull(),
    spanId: char('span_id', { length: 16 }).notNull(),
    parentSpanId: char('parent_span_id', { length: 16 }),

    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }),
    durationMs: numeric('duration_ms', { mode: 'number' }),

    attributes: jsonb('attributes').notNull(),

    exceptionType: text('exception_type'),
    exceptionMessage: text('exception_message'),
    exceptionStacktrace: text('exception_stacktrace'),

    httpMethod: text('http_method'),
    httpRoute: text('http_route'),
    httpStatusCode: integer('http_status_code'),
    httpUrl: text('http_url'),
    httpHost: text('http_host'),
    httpUserAgent: text('http_user_agent'),

    service: text('service'),
    version: text('version'),
    environment: text('environment'),
  },
  (table) => [
    uniqueIndex('tracing_span_pk').on(table.traceId, table.spanId, table.startTime),
    index('tracing_trace_id_idx').on(table.traceId),
    index('tracing_trace_start_time_idx').on(table.traceId, table.startTime),
    index('tracing_start_time_idx').on(table.startTime),
    index('tracing_http_status_code_idx').on(table.httpStatusCode),
    index('tracing_service_idx').on(table.service),
  ],
);

export type InsertTrace = typeof Traces.$inferInsert;
export type SelectTrace = typeof Traces.$inferSelect;
