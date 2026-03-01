import type {
  Logger,
  LoggerStats,
  Trace,
  TraceConfig,
  Tracer,
  TracerConfig,
  TracerStats,
  TraceSnapshot,
} from '@/types';

import { TraceImpl } from '@/middleware/trace';
import { BATCH_MAX_QUEUE_SIZE } from '@/utils/constants';

const DEFAULT_CONFIG: Partial<TracerConfig> = {
  interval: 10_000,
  threshold: 100,
  batchSize: 100,
  maxPendingTraces: BATCH_MAX_QUEUE_SIZE,
  maxRetries: 3,
  retryDelay: 1_000,
  debug: false,
};

let tracerInstanceCount = 0;

interface QueuedTrace {
  trace: TraceImpl;
  isError: boolean;
}

interface CommitResult {
  failed: Array<TraceSnapshot>;
  error?: Error;
}

class RingBuffer<T> {
  private buffer: Array<T | undefined>;
  private head = 0;
  private tail = 0;
  private size = 0;

  constructor(capacity = 1024) {
    this.buffer = new Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  get capacity(): number {
    return this.buffer.length;
  }

  enqueue(value: T): void {
    if (this.size === this.buffer.length) {
      this.grow();
    }
    this.buffer[this.tail] = value;
    this.tail = (this.tail + 1) % this.buffer.length;
    this.size++;
  }

  dequeue(): T | undefined {
    if (this.size === 0) return undefined;
    const value = this.buffer[this.head];
    this.buffer[this.head] = undefined;
    this.head = (this.head + 1) % this.buffer.length;
    this.size--;
    return value;
  }

  dequeueBatch(count: number): Array<T> {
    const size = Math.min(count, this.size);
    const out = new Array<T>(size);
    for (let i = 0; i < size; i++) {
      out[i] = this.dequeue() as T;
    }
    return out;
  }

  forEach(callback: (value: T) => void): void {
    for (let i = 0; i < this.size; i++) {
      const value = this.buffer[(this.head + i) % this.buffer.length]!;
      callback(value);
    }
  }

  private grow(): void {
    const next = new Array<T | undefined>(this.buffer.length * 2);
    for (let i = 0; i < this.size; i++) {
      next[i] = this.buffer[(this.head + i) % this.buffer.length];
    }
    this.buffer = next;
    this.head = 0;
    this.tail = this.size;
  }
}

export class TracerImpl implements Tracer {
  private readonly loggers: Array<Logger>;
  private readonly config: TracerConfig;

  private instanceId: number;

  private activeTraces = new Map<string, TraceImpl>();
  private pendingQueue: RingBuffer<QueuedTrace>;
  private activeBatch: Array<QueuedTrace> = [];
  private isCommitting = false;

  private loggerStats = new Map<string, LoggerStats>();

  private totalCommitted = 0;
  private totalFailed = 0;

  private commitTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<TracerConfig> & { loggers: Array<Logger> }) {
    this.loggers = config.loggers;
    const filteredConfig = Object.fromEntries(
      Object.entries(config).filter(([_, v]) => v !== undefined),
    );
    this.config = {
      ...DEFAULT_CONFIG,
      ...filteredConfig,
    } as TracerConfig;

    this.instanceId = ++tracerInstanceCount;
    const initialCapacity = Number.isFinite(this.config.maxPendingTraces)
      ? Math.min(this.config.maxPendingTraces, this.config.batchSize * 2)
      : this.config.batchSize * 2;
    this.pendingQueue = new RingBuffer<QueuedTrace>(Math.max(16, initialCapacity));

    this.logDebug(`[tracing] Creating TracerImpl instance #${this.instanceId}`);

    for (const logger of this.loggers) {
      this.loggerStats.set(logger.id, {
        committed: 0,
        failed: 0,
      });
    }

    this.startCommitTimer();
  }

  private startCommitTimer(): void {
    this.commitTimer = setInterval(() => {
      void this.commit();
    }, this.config.interval);
  }

  private get pendingCount(): number {
    return this.pendingQueue.length;
  }

  public logDebug = (message: string): void => {
    if (this.config.debug) {
      console.debug(message);
    }
  };

  private enqueueTrace = (entry: QueuedTrace): void => {
    this.pendingQueue.enqueue(entry);
    this.enforcePendingLimit();
  };

  private dequeueBatch = (size: number): Array<QueuedTrace> => {
    if (this.pendingCount === 0) return [];
    return this.pendingQueue.dequeueBatch(size);
  };

  private enforcePendingLimit = (): void => {
    const maxPending = this.config.maxPendingTraces;
    if (!Number.isFinite(maxPending) || maxPending <= 0) return;

    const pendingCount = this.pendingCount;
    if (pendingCount <= maxPending) return;

    let remaining = pendingCount - maxPending;
    let removed = 0;
    const next = new RingBuffer<QueuedTrace>(this.pendingQueue.capacity);

    this.pendingQueue.forEach((entry) => {
      if (!entry.isError && remaining > 0) {
        remaining--;
        removed++;
        return;
      }
      next.enqueue(entry);
    });

    this.pendingQueue = next;

    if (removed > 0) {
      console.warn(
        `[tracing] Evicted ${removed} non-error traces to cap pending queue at ${maxPending}`,
      );
    }

    if (remaining > 0) {
      console.warn(
        `[tracing] Pending queue exceeded limit (${maxPending}) but only error traces remain`,
      );
    }
  };

  startTrace = (config?: TraceConfig): Trace => {
    const trace = new TraceImpl(this, config);
    this.activeTraces.set(trace.id, trace);
    return trace;
  };

  onTraceFinished = (trace: TraceImpl): void => {
    this.activeTraces.delete(trace.id);
    this.enqueueTrace({
      trace,
      isError: trace.hasErrorSpan(),
    });

    this.logDebug(`[tracing] Trace ${trace.id} finished. Pending: ${this.pendingCount}`);

    if (this.pendingCount >= this.config.threshold) {
      this.logDebug(
        `[tracing] Threshold reached (${this.config.threshold}), triggering commit`,
      );
      void this.commit();
    }
  };

  private commit = async (): Promise<void> => {
    if (this.isCommitting || this.pendingCount === 0) {
      return;
    }

    this.isCommitting = true;

    try {
      do {
        const batch = this.dequeueBatch(this.config.batchSize);
        if (batch.length === 0) break;
        this.activeBatch = batch;
        await this.flushBatch(batch);
      } while (this.pendingCount >= this.config.threshold);
    } catch (error) {
      console.error('[tracing] Commit loop failed:', error);
    } finally {
      this.activeBatch = [];
      this.isCommitting = false;
    }
  };

  private flushBatch = async (batch: Array<QueuedTrace>): Promise<void> => {
    const snapshots = batch.map((entry) => entry.trace.toSnapshot());
    this.logDebug(
      `[tracing] Flushing ${snapshots.length} traces to ${this.loggers.length} loggers`,
    );

    const failedTraceIds = new Set<string>();
    const loggerErrors: Array<{ id: string; error: Error }> = [];

    const commitPromises = this.loggers.map(async (logger) => {
      const result = await this.commitWithBackoff(logger, snapshots);
      const stats = this.loggerStats.get(logger.id)!;
      stats.committed += snapshots.length - result.failed.length;
      stats.failed += result.failed.length;

      if (result.error) {
        stats.lastError = result.error;
        loggerErrors.push({ id: logger.id, error: result.error });
      } else {
        stats.lastError = undefined;
        stats.lastSuccess = new Date();
      }

      if (result.failed.length > 0) {
        for (const failedTrace of result.failed) {
          failedTraceIds.add(failedTrace.id);
        }
      }
    });

    await Promise.all(commitPromises);

    for (const entry of loggerErrors) {
      console.error(`[tracing] Logger ${entry.id} commit failed:`, entry.error);
    }

    const retry: Array<QueuedTrace> = [];
    const succeeded: Array<QueuedTrace> = [];

    for (const entry of batch) {
      if (failedTraceIds.has(entry.trace.id)) {
        retry.push(entry);
      } else {
        succeeded.push(entry);
      }
    }

    this.totalCommitted += succeeded.length;
    this.totalFailed += retry.length;

    if (retry.length > 0) {
      const nextQueue = new RingBuffer<QueuedTrace>(
        Math.max(this.pendingQueue.capacity, retry.length + this.pendingQueue.length),
      );
      for (const entry of retry) {
        nextQueue.enqueue(entry);
      }
      this.pendingQueue.forEach((entry) => {
        nextQueue.enqueue(entry);
      });
      this.pendingQueue = nextQueue;
      this.enforcePendingLimit();
      console.warn(`[tracing] Requeued ${retry.length} traces after commit failures`);
    }

    if (succeeded.length > 0) {
      this.logDebug(
        `[tracing] Committed ${succeeded.length} traces (${retry.length} failed)`,
      );
    }
  };

  private commitWithBackoff = async (
    logger: Logger,
    snapshots: Array<TraceSnapshot>,
  ): Promise<CommitResult> => {
    let failed = snapshots;
    let attempt = 0;

    while (failed.length > 0 && attempt < this.config.maxRetries) {
      try {
        failed = await logger.commit(failed);

        if (failed.length === 0) {
          return { failed: [] };
        }

        attempt++;
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelay * 2 ** (attempt - 1);
          this.logDebug(
            `[tracing] Logger ${logger.id} retry ${attempt}/${this.config.maxRetries} for ${failed.length} traces in ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      } catch (error) {
        return { failed, error: error as Error };
      }
    }

    return { failed };
  };

  getStats = (): TracerStats => ({
    active: this.activeTraces.size,
    pending: this.pendingCount,
    committing: this.activeBatch.length,
    committed: this.totalCommitted,
    failed: this.totalFailed,
    byLogger: new Map(this.loggerStats),
  });

  dispose = async (): Promise<void> => {
    if (this.commitTimer) {
      clearInterval(this.commitTimer);
      this.commitTimer = null;
    }

    while (this.isCommitting) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    while (this.pendingCount > 0) {
      await this.commit();
    }

    this.logDebug('[tracing] Tracer disposed');
  };
}

export const createTracer = (
  config: Partial<TracerConfig> & { loggers: Array<Logger> },
): Tracer => new TracerImpl(config);
