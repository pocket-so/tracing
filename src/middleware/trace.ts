import type { TracerImpl } from '@/middleware/tracer';
import type { Span, SpanConfig, Trace, TraceSnapshot } from '@/types';

import { SpanImpl } from '@/middleware/span';
import { hasErrorAttributes } from '@/utils/errors';
import { generateTraceId } from '@/utils/ids';

export class TraceImpl implements Trace {
  public readonly id: string;
  public readonly startTime: number;
  public endTime: number | null = null;
  public duration: number | null = null;
  private _isFinished = false;

  private readonly tracer: TracerImpl;
  private readonly _spans: Array<SpanImpl> = [];
  private readonly startPerf: number;

  constructor(tracer: TracerImpl, config?: { id?: string }) {
    this.tracer = tracer;
    this.id = config?.id ?? generateTraceId();
    this.startTime = Date.now();
    this.startPerf = performance.now();
  }

  get spans(): ReadonlyArray<Span> {
    return this._spans;
  }

  get isFinished(): boolean {
    return this._isFinished;
  }

  startSpan = (config: SpanConfig): Span => {
    if (this._isFinished) {
      throw new Error(`Cannot start span on finished trace ${this.id}`);
    }

    return new SpanImpl(this, config, null);
  };

  _registerSpan = (span: SpanImpl): void => {
    this._spans.push(span);
  };

  finish = (): void => {
    if (this._isFinished) {
      this.logDebug(`Trace ${this.id} finish() called multiple times`);
      return;
    }

    this._isFinished = true;
    this.endTime = Date.now();
    this.duration = Math.max(0, performance.now() - this.startPerf);

    for (const span of this._spans) {
      if (span.endTime === null) {
        span.stop();
      }
    }

    this.tracer.onTraceFinished(this);
  };

  toSnapshot = (): TraceSnapshot => {
    const spans = new Array<TraceSnapshot['spans'][number]>(this._spans.length);
    for (let i = 0; i < this._spans.length; i++) {
      const span = this._spans[i]!;
      spans[i] = {
        id: span.id,
        traceId: this.id,
        parentSpanId: span.parentSpan?.id ?? null,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.duration,
        attributes: span.attributes,
      };
    }

    return {
      id: this.id,
      startTime: this.startTime,
      endTime: this.endTime,
      duration: this.duration,
      spans,
    };
  };

  hasErrorSpan = (): boolean => {
    for (const span of this._spans) {
      if (hasErrorAttributes(span.attributes)) return true;
    }
    return false;
  };

  logDebug = (message: string): void => {
    this.tracer.logDebug(message);
  };
}
