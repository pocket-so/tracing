import type { Logger, LoggerHealth, ServiceMetadata, TraceSnapshot } from '@/types';

export interface ConsoleLoggerConfig {
  metadata: ServiceMetadata;
}

class ConsoleLogger implements Logger {
  private static instance: ConsoleLogger | null = null;

  public readonly id = 'console';
  private readonly metadata: ServiceMetadata;

  private lastError?: Error;
  private lastSuccess?: Date;

  private formatPayload = (payload: Record<string, unknown>): string =>
    Object.entries(payload)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');

  private constructor(config: ConsoleLoggerConfig) {
    this.metadata = config.metadata;
  }

  static getInstance(config: ConsoleLoggerConfig): ConsoleLogger {
    if (!ConsoleLogger.instance) {
      ConsoleLogger.instance = new ConsoleLogger(config);
    }
    return ConsoleLogger.instance;
  }

  commit = async (traces: Array<TraceSnapshot>): Promise<Array<TraceSnapshot>> => {
    try {
      const spanCount = traces.reduce((total, trace) => total + trace.spans.length, 0);
      const output = this.formatPayload({
        count: traces.length,
        spans: spanCount,
        service: this.metadata.service,
        version: this.metadata.version,
        environment: this.metadata.environment,
      });
      const timestamp = new Date().toISOString();
      console.log(`level=log ts=${timestamp} msg=trace-batch ${output}`);
      this.lastSuccess = new Date();
      this.lastError = undefined;
      return []; // All traces committed successfully
    } catch (error) {
      console.error('[console-logger] Error:', error);
      this.lastError = error as Error;
      return traces;
    }
  };

  health = (): LoggerHealth => ({
    healthy: this.lastError === undefined || this.lastSuccess !== undefined,
    lastError: this.lastError,
    lastSuccess: this.lastSuccess,
  });
}

export const getConsoleLogger = (config: ConsoleLoggerConfig): Logger =>
  ConsoleLogger.getInstance(config);
