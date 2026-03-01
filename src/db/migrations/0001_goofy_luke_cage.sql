ALTER TABLE "tracing_spans" ALTER COLUMN "trace_id" SET DATA TYPE char(32);--> statement-breakpoint
ALTER TABLE "tracing_spans" ALTER COLUMN "span_id" SET DATA TYPE char(16);--> statement-breakpoint
ALTER TABLE "tracing_spans" ALTER COLUMN "parent_span_id" SET DATA TYPE char(16);--> statement-breakpoint
ALTER TABLE "tracing_spans" ALTER COLUMN "duration_ms" SET DATA TYPE numeric;