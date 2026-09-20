# OpenTelemetry reference snippet

Copy `with-tracing.ts` into an application that depends on `@reatom/core` and
`@reatom/opentelemetry`. This directory remains a reference snippet, with no
standalone package or server. It uses the adapter's context and export pipeline.

```ts
import { createTracedCounter } from './with-tracing'

const counter = createTracedCounter({
  endpoint: 'https://collector.example.com',
  serviceName: 'counter-app',
})

// Call in the application's current Reatom context.
const result = counter.update()
console.log(result.count, result.doubled, result.context)

// Before shutting down; flush completion is not a delivery guarantee.
await counter.flush()
counter.dispose()
```

Each update starts a new root. `example.increment` and `example.double` are
siblings; the `example.count` write belongs to `example.increment`. Repeated
cached reads emit nothing. In asynchronous flows, use `await wrap(promise)`
to retain context and cancellation.

The earlier standalone `startTracing`/`createTracingExtension` implementation
and writable ID variables have been replaced by the package API. There is no
remote-parent or partial-ID setter. For application integrations, use
`otel.startTrace(name, callback)` and `otel.getCurrentContext()` directly.
