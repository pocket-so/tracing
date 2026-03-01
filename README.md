# tracing

Internal tracing helpers for Hono backends (Node/Bun/Cloudflare Workers).

## Install

```bash
bun add @pocket/tracing
```

## Ignore Routes

Skip tracing for specific paths. Use `ignore.list` for the paths and `ignore.exact` (default `true`) for matching:

- **`exact: true`** (default) – only paths in the list are ignored (exact match).
- **`exact: false`** – each list entry also matches nested subpaths (e.g. `/openapi` ignores `/openapi`, `/openapi/spec`, `/openapi/docs`).

Legacy: you can still pass an array of strings; it is treated as `{ exact: true, list: [...] }`.

```typescript
app.use(
  tracing({
    loggers: [],
    ignore: { exact: true, list: ['/openapi', '/ready'] },
  }),
);

// Ignore /openapi and all nested paths
app.use(
  tracing({
    loggers: [],
    ignore: { exact: false, list: ['/openapi'] },
  }),
);
```

## Error handling

You can pass an optional `onError` callback to be notified when a batch commit fails (e.g. export to Axiom/Sentry fails). Use it for logging, metrics, or custom alerting. The callback receives the error; it is best-effort and does not affect request handling.

```typescript
app.use(
  tracing({
    loggers: [getAxiomLogger(config)],
    onError: (err) => {
      console.error('Tracing export failed', err);
      // or: metrics.increment('tracing.export.failed');
    },
  }),
);
```

## Logger singleton and testing

Each logger is exposed as a **singleton** via `getXxxLogger(config)` (e.g. `getAxiomLogger`, `getSentryLogger`, `getConsoleLogger`, `getTimescaleLogger`). The **first config wins**: the first call to `getXxxLogger(config)` creates the instance and caches it; later calls with different config return the same instance and ignore the new config. This is intentional for production (single process, one config).

For **tests** or when you need multiple instances or a fresh instance per run, use the **factory** instead:

- `createAxiomLogger(config)` – new Axiom logger instance
- `createSentryLogger(config)` – new Sentry logger instance
- `createConsoleLogger(config)` – new Console logger instance
- `createTimescaleLogger(config)` – new Timescale logger instance

Each factory returns a new `Logger` every time and does not touch the singleton. Example:

```typescript
import { createConsoleLogger } from '@pocket/tracing/loggers/console';

const testLogger = createConsoleLogger({ metadata: { service: 'test', version: '0', environment: 'test' } });
// testLogger is a new instance; getConsoleLogger() singleton is unchanged
```

## Build and runtimes

The package is built with a **browser** platform target (single bundle). Middleware and loggers (Axiom, Sentry, Console) are suitable for Node, Bun, and Cloudflare Workers. The **Timescale logger** and the **`@pocket/tracing/timescale/db`** export are **server-only**: they depend on `postgres` and Drizzle and must not be used in browser environments. Use them only in Node, Bun, or Workers backends.

## Graceful Shutdown

To ensure all pending traces are flushed on shutdown, get the tracer with `getTracer()` and call `dispose()`:

```typescript
import { getTracer, tracing } from '@pocket/tracing/middleware';

app.use(tracing({ loggers: [/* ... */] }));

// For Node.js / Bun
process.on('SIGTERM', async () => {
  const tracer = getTracer();
  if (tracer) await tracer.dispose();
  process.exit(0);
});

// For Cloudflare Workers
export default {
  async fetch(request, env, ctx) {
    const response = await app.fetch(request, env, ctx);
    const tracer = getTracer();
    if (tracer) ctx.waitUntil(tracer.dispose());
    return response;
  },
};
```
