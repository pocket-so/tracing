export type SpanAttributeValue = string | number | boolean;

export interface Trace {
  readonly id: string;
  readonly spans: ReadonlyArray<Span>;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly duration: number | null;
  readonly isFinished: boolean;
  startSpan(config: SpanConfig): Span;
  finish(): void;
}

export interface Span {
  readonly id: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number | null;
  readonly duration: number | null;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
  readonly trace: Trace;
  readonly parentSpan: Span | null;
  readonly childSpans: ReadonlyArray<Span>;
  startSpan(config: SpanConfig): Span;
  setAttributes(attrs: Record<string, SpanAttributeValue | undefined>): void;
  stop(): void;
  wrap<T>(config: SpanConfig, fn: (span: Span) => Promise<T> | T): Promise<T>;
}

export interface SpanSnapshot {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
}

export interface TraceSnapshot {
  id: string;
  startTime: number;
  endTime: number | null;
  duration: number | null;
  spans: Array<SpanSnapshot>;
}

export interface Tracer {
  startTrace(config?: TraceConfig): Trace;
  getStats(): TracerStats;
  dispose(): Promise<void>;
}

export interface TracerStats {
  active: number;
  pending: number;
  committing: number;
  committed: number;
  failed: number;
  byLogger: Map<string, LoggerStats>;
}

export interface LoggerStats {
  committed: number;
  failed: number;
}

export interface Logger {
  readonly id: string;
  commit(
    traces: Array<TraceSnapshot>,
    onError?: (error?: Error) => void | undefined,
  ): Promise<Array<TraceSnapshot>>;
}

export interface TracerConfig {
  loggers: Array<Logger>;
  interval: number;
  threshold: number;
  batchSize: number;
  maxPendingTraces: number;
  maxRetries: number;
  retryDelay: number;
  onError?: (error?: Error) => void | undefined;
  debug: boolean;
}

export interface TraceConfig {
  id?: string;
}

export interface SpanConfig {
  name: string;
  attributes?: Record<string, SpanAttributeValue | undefined>;
}

export interface ServiceMetadata {
  service: string;
  version: string;
  environment: string;
}
