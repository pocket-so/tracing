ALTER TABLE "tracing_spans" RENAME COLUMN "http_status" TO "http_status_code";--> statement-breakpoint
DROP INDEX "tracing_error_idx";--> statement-breakpoint
DROP INDEX "tracing_http_status_idx";--> statement-breakpoint
CREATE INDEX "tracing_http_status_code_idx" ON "tracing_spans" USING btree ("http_status_code");--> statement-breakpoint
ALTER TABLE "tracing_spans" DROP COLUMN "error";
