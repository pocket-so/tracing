/**
 * Size constants for ID generation
 * Per OpenTelemetry spec:
 * - Trace ID: 16 bytes
 * - Span ID: 8 bytes
 */

export const TRACE_ID_BYTES = 16;
export const SPAN_ID_BYTES = 8;

const HEX_TABLE: Array<string> = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => HEX_TABLE[byte]!).join('');

const randomHex = (bytes: number): string => {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toHex(buffer);
};

export const generateTraceId = (): string => randomHex(TRACE_ID_BYTES);
export const generateSpanId = (): string => randomHex(SPAN_ID_BYTES);
