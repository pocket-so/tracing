import { MAX_PORT, MIN_PORT } from './constants';

/**
 * Validate and parse port number.
 *
 * @param portStr - Port string (e.g. from Host header).
 * @returns Parsed port, or undefined if portStr is undefined.
 * @throws Error if portStr is present but not an integer in MIN_PORT–MAX_PORT.
 */
export const parsePort = (portStr: string | undefined): number | undefined => {
  if (!portStr) return undefined;

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`Invalid port number: ${portStr}. Expected ${MIN_PORT}-${MAX_PORT}.`);
  }

  return port;
};
