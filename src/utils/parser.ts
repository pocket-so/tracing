import { MAX_PORT, MIN_PORT } from './constants';

/**
 * Validate and parse port number
 */
export const parsePort = (portStr: string | undefined): number | undefined => {
  if (!portStr) return undefined;

  const port = Number(portStr);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    console.warn(`Invalid port number: ${portStr}. Expected ${MIN_PORT}-${MAX_PORT}.`);
    return undefined;
  }

  return port;
};
