import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
} from '@opentelemetry/semantic-conventions';

import type { TraceImpl } from '@/middleware/trace';
import type { Span, SpanAttributeValue, SpanConfig, Trace } from '@/types';

import { extractErrorInfo } from '@/utils/errors';
import { generateSpanId } from '@/utils/ids';

export class SpanImpl implements Span {
  public readonly id: string;
  public readonly name: string;
  public readonly startTime: number;
  public endTime: number | null = null;
  public duration: number | null = null;

  private readonly _trace: TraceImpl;
  private readonly _parentSpan: SpanImpl | null;

  public get trace(): Trace {
    return this._trace;
  }

  public get parentSpan(): Span | null {
    return this._parentSpan;
  }

  private readonly _childSpans: Array<SpanImpl> = [];
  private childSpansSnapshot: ReadonlyArray<Span> | null = null;
  private readonly _attributes: Record<string, SpanAttributeValue> = {};
  private attributesSnapshot: Readonly<Record<string, SpanAttributeValue>> | null = null;
  private readonly startPerf: number;

  constructor(trace: TraceImpl, config: SpanConfig, parentSpan: SpanImpl | null) {
    this._trace = trace;
    this._parentSpan = parentSpan;
    this.id = generateSpanId();
    this.name = config.name;
    this.startTime = Date.now();
    this.startPerf = performance.now();

    if (config.attributes) {
      for (const key in config.attributes) {
        if (!Object.hasOwn(config.attributes, key)) continue;
        const value = config.attributes[key];
        if (value === undefined) continue;
        this._attributes[key] = value;
      }
      this.attributesSnapshot = null;
    }

    trace._registerSpan(this);

    if (this._parentSpan) {
      this._parentSpan._childSpans.push(this);
      this._parentSpan.childSpansSnapshot = null;
    }
  }

  get attributes(): Readonly<Record<string, SpanAttributeValue>> {
    if (!this.attributesSnapshot) {
      this.attributesSnapshot = Object.freeze({ ...this._attributes });
    }
    return this.attributesSnapshot;
  }

  get childSpans(): ReadonlyArray<Span> {
    if (!this.childSpansSnapshot) {
      this.childSpansSnapshot = Object.freeze([
        ...this._childSpans,
      ]) as ReadonlyArray<Span>;
    }
    return this.childSpansSnapshot;
  }

  startSpan = (config: SpanConfig): Span => new SpanImpl(this._trace, config, this);

  setAttributes = (attrs: Record<string, SpanAttributeValue | undefined>): void => {
    let updated = false;
    for (const key in attrs) {
      if (!Object.hasOwn(attrs, key)) continue;
      const value = attrs[key];
      if (value === undefined) continue;
      this._attributes[key] = value;
      updated = true;
    }
    if (updated) {
      this.attributesSnapshot = null;
    }
  };

  stop = (): void => {
    if (this.endTime !== null) {
      this._trace.logDebug(`Span ${this.name} (${this.id}) stopped multiple times`);
      return;
    }
    this.endTime = Date.now();
    this.duration = Math.max(0, performance.now() - this.startPerf);
  };

  wrap = async <T>(
    wrapConfig: SpanConfig,
    fn: (span: Span) => Promise<T> | T,
  ): Promise<T> => {
    const child = this.startSpan(wrapConfig);
    try {
      return await Promise.resolve(fn(child));
    } catch (error) {
      const { type, message, stack } = extractErrorInfo(error);
      child.setAttributes({
        [ATTR_EXCEPTION_TYPE]: type,
        [ATTR_EXCEPTION_MESSAGE]: message,
        [ATTR_EXCEPTION_STACKTRACE]: stack,
      });
      throw error;
    } finally {
      child.stop();
    }
  };
}
