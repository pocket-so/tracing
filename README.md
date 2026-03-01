# @pocket/tracing

Tracing middleware for Hono backends (Node/Bun). Built on OpenTelemetry.

**Exports:** `middleware`, loggers (`axiom`, `sentry`, `timescale`, `console`), `timescale/db`, `utils/helpers`.

## Install

```bash
bun add @pocket/tracing
```

## Usage

```ts
import { tracing } from '@pocket/tracing/middleware';
import { consoleLogger } from '@pocket/tracing/loggers/console';

app.use(
  tracing({
    loggers: [consoleLogger()],
    ignore: ['/health', '/openapi'],
  }),
);
```

## Graceful shutdown

Flush pending traces before exit:

```ts
// access the tracer from context or a shared instance
process.on('SIGTERM', async () => {
  await tracer.dispose();
  process.exit(0);
});
```
