CREATE TABLE "tracing_spans" (
	"trace_id" uuid NOT NULL,
	"span_id" uuid NOT NULL,
	"parent_span_id" uuid,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone,
	"duration_ms" bigint,
	"attributes" jsonb NOT NULL,
	"error" boolean,
	"exception_type" text,
	"exception_message" text,
	"exception_stacktrace" text,
	"http_method" text,
	"http_route" text,
	"http_status" integer,
	"http_url" text,
	"http_host" text,
	"http_user_agent" text,
	"service" text,
	"version" text,
	"environment" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "tracing_span_pk" ON "tracing_spans" USING btree ("trace_id","span_id","start_time");--> statement-breakpoint
CREATE INDEX "tracing_trace_id_idx" ON "tracing_spans" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "tracing_trace_start_time_idx" ON "tracing_spans" USING btree ("trace_id","start_time");--> statement-breakpoint
CREATE INDEX "tracing_start_time_idx" ON "tracing_spans" USING btree ("start_time");--> statement-breakpoint
CREATE INDEX "tracing_error_idx" ON "tracing_spans" USING btree ("error");--> statement-breakpoint
CREATE INDEX "tracing_http_status_idx" ON "tracing_spans" USING btree ("http_status");--> statement-breakpoint
CREATE INDEX "tracing_service_idx" ON "tracing_spans" USING btree ("service");

-- manually added a hypertable
SELECT create_hypertable('tracing_spans', 'start_time', if_not_exists => TRUE);