/** Default timeout for logger operations (30 seconds) */
export const DEFAULT_LOGGER_TIMEOUT_MS = 30_000;

/** Default max length for stacktrace attributes */
export const DEFAULT_STACKTRACE_MAX_LENGTH = 2_000;

/** Default stacktrace included in Axiom */
export const DEFAULT_STACKTRACE_AXIOM_INCLUDE = false;

/** Default batch size for database inserts */
export const DEFAULT_BATCH_SIZE = 1_000;

/** Port validation constants */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;

/** Batching configuration - 10 second flush interval */
export const BATCH_MAX_QUEUE_SIZE = 10_000; // Safety limit (log warning if exceeded)
export const BATCH_MAX_BATCH_SIZE = 100; // Process immediately when reached
export const BATCH_FLUSH_INTERVAL_MS = 10_000; // 10 seconds
export const BATCH_MAX_CONCURRENT_BATCHES = 3; // Concurrent batch processing
export const BATCH_EXPORT_TIMEOUT_MS = 30_000; // Per-logger export timeout
export const BATCH_RETRY_DELAY_MS = 1_000; // Delay before retry
