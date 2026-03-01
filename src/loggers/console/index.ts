import type { Logger, ServiceMetadata, TraceSnapshot } from '@/types';

export interface ConsoleLoggerConfig {
  metadata: ServiceMetadata;
}

class ConsoleLogger implements Logger {
  private static instance: ConsoleLogger | null = null;

  public readonly id = 'console';
  private readonly metadata: ServiceMetadata;

  private formatPayload = (payload: Record<string, unknown>): string =>
    Object.entries(payload)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');

  private constructor(config: ConsoleLoggerConfig) {
    this.metadata = config.metadata;
  }

  /**
   * Returns the singleton instance. First config wins; later calls ignore config.
   */
  static getInstance(config: ConsoleLoggerConfig): ConsoleLogger {
    if (!ConsoleLogger.instance) {
      ConsoleLogger.instance = new ConsoleLogger(config);
    }
    return ConsoleLogger.instance;
  }

  /**
   * Creates a new instance without touching the singleton. Use for tests or multiple configs.
   */
  static create(config: ConsoleLoggerConfig): ConsoleLogger {
    return new ConsoleLogger(config);
  }

  commit = async (traces: Array<TraceSnapshot>): Promise<Array<TraceSnapshot>> => {
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

    return [];
  };
}

/**
 * Returns the singleton Console logger. First config wins; subsequent calls return the same
 * instance and ignore config. For a new instance (e.g. tests), use createConsoleLogger.
 */
export const getConsoleLogger = (config: ConsoleLoggerConfig): Logger =>
  ConsoleLogger.getInstance(config);

/**
 * Creates a new Console logger instance without using or updating the singleton.
 * Use for tests or when you need multiple instances.
 *
 * @param config - Same as getConsoleLogger.
 * @returns A new Logger instance.
 */
export const createConsoleLogger = (config: ConsoleLoggerConfig): Logger =>
  ConsoleLogger.create(config);
