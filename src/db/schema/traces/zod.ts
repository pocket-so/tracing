import { z } from '@hono/zod-openapi';

export const TraceSchema = z.object({
  traceId: z.string().length(32).openapi({
    description: 'Identifier of the trace',
    example: 'Ld2oE0WZyQanvvv2dA2BB6NYWY5zqZTZ',
  }),
  spanId: z.string().length(16).openapi({
    description: 'Identifier of the span',
    example: '30p3uKFhJdCEJyui',
  }),
  parentSpanId: z.string().length(16).nullable().openapi({
    description: 'Identifier of the parent span',
    example: '15Zt2TjkiHQP3ePg',
  }),

  startTime: z.coerce.date().openapi({
    description: 'Date and time the trace was started',
    example: '2026-01-28T12:00:00.000Z',
  }),
  endTime: z.coerce.date().nullable().openapi({
    description: 'Date and time the trace was ended',
    example: '2026-01-28T12:00:00.000Z',
  }),
  durationMs: z.coerce.number().nullable().openapi({
    description: 'Duration of the trace in milliseconds',
    example: '120ms',
  }),

  attributes: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .openapi({
      description: 'Span attributes',
      example: { 'http.method': 'GET' },
    }),

  exceptionType: z.string().nullable().openapi({
    description: 'Exception type (if any)',
    example: 'TypeError',
  }),
  exceptionMessage: z.string().nullable().openapi({
    description: 'Exception message (if any)',
    example: 'bad input',
  }),
  exceptionStacktrace: z.string().nullable().openapi({
    description: 'Exception stacktrace (if any)',
    example: 'Error: bad input\n    at handler (index.ts:42:13)',
  }),

  httpMethod: z.string().nullable().openapi({
    description: 'HTTP method',
    example: 'GET',
  }),
  httpRoute: z.string().nullable().openapi({
    description: 'Matched HTTP route',
    example: '/api/v1/session',
  }),
  httpStatusCode: z.coerce.number().int().nullable().openapi({
    description: 'HTTP response status code',
    example: 200,
  }),
  httpUrl: z.string().nullable().openapi({
    description: 'Full HTTP URL',
    example: 'https://api.example.com/v1/session',
  }),
  httpHost: z.string().nullable().openapi({
    description: 'HTTP host header',
    example: 'api.example.com',
  }),
  httpUserAgent: z.string().nullable().openapi({
    description: 'User-Agent header',
    example: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  }),

  service: z.string().nullable().openapi({
    description: 'Service name',
    example: 'api',
  }),
  version: z.string().nullable().openapi({
    description: 'Service version',
    example: '1.2.3',
  }),
  environment: z.string().nullable().openapi({
    description: 'Runtime environment',
    example: 'production',
  }),
});

export type Trace = z.infer<typeof TraceSchema>;
