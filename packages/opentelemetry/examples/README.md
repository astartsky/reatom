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

const gate = Promise.resolve()
console.log(await counter.updateAfter(gate))

// Before shutting down; flush completion is not a delivery guarantee.
await counter.flush()
counter.dispose()
```

Each `update` starts a root and calls the traced `example.increment` action.
The counter write and `example.double` computed read remain ordinary Reatom
work: they do not emit spans. Repeated cached reads emit nothing.

`updateAfter` is the async form. The action saves `otel.getCurrentContext()`
before `await wrap(wait)`, which preserves the Reatom store and cancellation
scope. It then calls `otel.withContext(saved, increment)` after the await, so
the resumed increment is a child of the action. `wrap` alone does not preserve
the OpenTelemetry context; `withContext` is synchronous and restores its
caller immediately, even when its callback returns a Promise.

This example belongs to the package and is separate from the original
`examples/opentelemetry` implementation. For application integrations, use
`otel.startTrace(name, callback)` and `otel.getCurrentContext()` directly.
