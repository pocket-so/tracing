export const pickString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const coercePrimitive = (value: unknown): string | undefined => {
  if (value === null || value === undefined) return undefined;
  switch (typeof value) {
    case 'string': {
      return value.length > 0 ? value : undefined;
    }
    case 'number':
    case 'boolean':
    case 'bigint': {
      return String(value);
    }
    case 'symbol': {
      return value.toString();
    }
    default: {
      return undefined;
    }
  }
};
