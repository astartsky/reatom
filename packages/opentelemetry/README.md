# @reatom/opentelemetry

OpenTelemetry tracing for [Reatom](https://www.reatom.dev). Auto-instruments
actions, batches spans, and ships them to any
[OTLP/HTTP JSON](https://opentelemetry.io/docs/specs/otlp/#otlphttp) collector.
No OpenTelemetry SDK dependency or changes to `@reatom/core`.

## Install

```sh
npm install @reatom/opentelemetry
```

## Quick start

```ts
import { wrap } from '@reatom/core'
import { reatomOpentelemetry } from '@reatom/opentelemetry'

const otel = reatomOpentelemetry({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-app',
  version: '1.0.0',
})

// Eligible actions created from this point on emit execution metadata.
// Parameter and result values are not captured by default.
// Import modules that create application models after installing tracing.
await wrap(import('./app.ts'))
```

Static imports run before the statements in their module. Writing
`import './app.ts'` below the factory call does not delay model creation; use
the dynamic import above or create models explicitly after the factory.
The default is metadata only. See [value capture](#value-capture-and-size-limits)
for explicit opt-in and redaction. During page unload, the adapter attempts
`fetch({ keepalive: true })` within the shared document budget.

For same-origin collectors that don't need auth headers, you can opt into
`navigator.sendBeacon` for unload-time delivery:

```ts
const otel = reatomOpentelemetry({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-app',
  version: '1.0.0',
  useBeacon: true, // opt-in; see "Unload flushing" below for caveats
})
```

## Trace context model

Spans describe action calls and explicit `startTrace` operations. Atoms,
computed values, initializers and setters keep their ordinary behavior and do
not emit spans. There are no automatic reactive dependency links.

Each adapter keeps its own immutable `{ traceId, spanId }` pair for the current
synchronous call. Nested instrumented actions inherit that parent. Independent
calls begin separate traces; reading cached reactive data does not adopt an
old trace.

Use an explicit root to group sibling operations:

```ts
otel.startTrace('checkout', () => {
  reserveItems()
  submitOrder()
})

// Inside an instrumented action or explicit root:
const current = otel.getCurrentContext() // Readonly<{ traceId, spanId }> | undefined
```

`startTrace` creates a root even inside another trace. It preserves the
callback's result, original Promise or thrown value, reactive dependency
tracking, current store and cancellation scope. The outer trace context is
restored as soon as the callback returns, including when it returns a Promise.
A disposed adapter calls the callback directly.

### Async context

Reatom's `bind` and `wrap` retain their original behavior. They preserve Reatom
state and cancellation context, but do not capture this adapter's trace context.
Capture the pair before yielding and use `withContext` around work that should
continue that trace:

```ts
const load = action(async () => {
  const parent = otel.getCurrentContext()
  const response = await wrap(fetch('/api/items'))
  return otel.withContext(parent, () => acceptResponse(response))
}, 'load')
```

`withContext(pair, callback)` copies the pair, runs the callback synchronously,
and restores the caller's context in `finally`. It preserves the original
result, Promise and thrown value. If its callback also yields, re-enter the
saved context after that await. `withContext(undefined, callback)` explicitly
clears the parent for that call; it does not create a span. This also works for
external event handlers. Use Reatom's `bind` or `wrap` separately when the handler
needs a Reatom store or cancellation scope.

`getCurrentContext()` returns `undefined` outside these synchronous scopes or
after disposal. A callback invoked later without `withContext` sees the context
of its caller, not the context where the callback was registered.

If capacity rejects an ordinary span, its children retain the current admitted
parent. If capacity rejects an explicit root, its callback runs with no parent.
An admitted child then begins a fresh trace. Capture this absence explicitly
with `withContext` when continuing after an await. Later export loss does not
rewrite IDs already inherited by children.

**Source-breaking change in this unreleased API:** independent writable
`traceIdVar` and `spanIdVar` exports are removed. Use `getCurrentContext`,
`startTrace` and `withContext` with coherent pairs. There is no SDK context
bridge or automatic remote-parent propagation. `resourceAttributesVar` remains
a separate, shared ambient resource override.

Telemetry callbacks use untracked reads so their dependencies do not become
application dependencies. Reentrant actions invoked by telemetry callbacks are
not traced. These callbacks can still initialize state or perform other
application work; their effects are not rolled back. Keep filters and redaction
observational.

### Per-trace resource attributes

`resourceAttributesVar` is a Reatom variable for attaching extra resource
metadata to actions called within a scope. Set the override **before** calling
the observed action:

```ts
import { resourceAttributesVar } from '@reatom/opentelemetry'

resourceAttributesVar.run({ 'feature.flag': 'experiment-a' }, () =>
  trackExperiment(),
)
```

Factory defaults are copied at construction. Ambient overrides are copied at
span admission, before the action body, and override matching default keys.
These bounded snapshots own nested records, arrays and byte arrays. Changes
inside the action or after an await do not alter that span's Resource. The
ambient slot is intentionally shared: adapters in the same Reatom scope see
the override while keeping their own factory defaults. Application keys are
never automatically promoted to Resource attributes.

Spans with distinct resource
attributes are placed in **separate `resourceSpans` entries** within one
exported batch — each unique resource set keeps its own grouping per OTLP, so
traces from multiple environments or feature variants in the same batch
window are never silently merged.

## Configuration

```ts
reatomOpentelemetry({
  endpoint: string                                   // OTLP base URL (no /v1/traces suffix)
  serviceName: string                                // sets `service.name` resource attribute
  version?: string                                   // emitted as instrumentation `scope.version` (recommended)
  resourceAttributes?: Record<string, OtlpAttrValue> // extra resource attributes (e.g. deployment.environment)
  captureValues?: false | { redact?: (key: string, value: unknown) => unknown } // default false
  headers?: Record<string, string>                   // attached to every fetch (auth, API keys)
  filter?: (target: AtomLike) => boolean             // select actions for automatic instrumentation
  batchInterval?: number                             // default 3000 ms
  maxBatchSize?: number                              // default 100
  maxQueueSize?: number                              // default 1000
  exportTimeoutMs?: number                           // default 30000; separate batch and flush budgets
  maxBeaconBytes?: number                            // optional lower beacon limit; shared budget is at most 60 KiB
  useBeacon?: boolean                                // default false; opt-in for same-origin collectors without auth headers
  retry?: {                                          // OTLP retry tuning; defaults: 3 retries, 1s base, 30s cap, full jitter
    maxRetries?: number
    baseDelayMs?: number
    maxDelayMs?: number
  }
})
```

The factory returns:

```ts
{
  withOTel: (options?: { kind?: SpanKind }) => Ext   // see "Per-target overrides" below
  startTrace: <T>(name: string, callback: () => T) => T // new root in the current store
  withContext: <T>(pair: SpanContext | undefined, callback: () => T) => T // synchronous scope
  getCurrentContext: () => SpanContext | undefined   // immutable IDs for this adapter
  flush: () => Promise<void>                         // waits for the finished records present at invocation
  stats: () => TelemetryStats                        // immutable capacity and delivery snapshot
  dispose: () => void                                // unregisters the global extension and unload listeners
}
```

### Span kind

OTel `SpanKind` defaults to `internal`. Override per action when the work
crosses a process boundary so distributed-trace dashboards render it correctly:

```ts
const fetchUser = action(async (id: string) => {
  // ...
}, 'fetchUser').extend(otel.withOTel({ kind: 'client' }))
```

Allowed kinds: `internal`, `server`, `client`, `producer`, `consumer`.

### Filter

```ts
reatomOpentelemetry({
  // ...
  filter: (target) => !target.name.startsWith('private.'),
})
```

Automatic instrumentation only selects actions. It also excludes targets hidden
by Reatom's `isSkip`: names that start with `_` or contain `._`. The custom filter
further narrows eligibility. Filtered actions receive no telemetry middleware,
emit no span and do not reserve capacity or inspect values. Their synchronous
children still run in the caller's trace scope. Manual
`.extend(otel.withOTel())` enables a filtered or hidden action. Applying the
extension to an atom or computed value leaves it unchanged.

### Per-target overrides

`otel.withOTel(options)` is **idempotent**: applying it again to a target that
the global extension already instrumented merges the options (later override
wins) instead of installing a second middleware. So a global filter plus a
local kind override produces exactly one span per call.

To opt in only selected targets, combine a global filter with a local extension:

```ts
const otel = reatomOpentelemetry({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-app',
  filter: () => false,
})
const save = action((id: number) => persist(id), 'save').extend(otel.withOTel())
```

## Span shape

By default, spans contain execution metadata and no parameter, result or state
values. With `captureValues: {}`, the additional attributes are:

| Target         | Opt-in attributes on success      | Status on success | Status on failure                  |
| -------------- | --------------------------------- | ----------------- | ---------------------------------- |
| Action (sync)  | `params`, `payload`               | unset             | `error`, except control flow below |
| Action (async) | `params`, `payload` (final value) | unset             | `error`, except control flow below |

Successful executions leave span status **unset**. Application failures use
error status; cancellation and suspension follow the control-flow rules below.

Action `AbortError` and thrown `Promise` (Reatom's suspension primitive) are
control flow: status stays **unset**, with fixed `[AbortError]` or `[Suspension]`
markers by default. Opt-in abort reasons pass through capture and redaction.
Ordinary exceptions emit an
`exception` event with only a safely obtained built-in `exception.type` by
default (opaque exceptions use `Error`). Message, stack and status message
require opt-in. `exception.escaped` is never inferred or emitted. This package
keeps span exception events for its v1 wire compatibility; evolving exception
semantic conventions do not add a logs transport to this API.

## Behavior reference

### Auto-instrumentation timing

The factory instruments eligible actions created after it is called.
Existing targets are not retroactively instrumented. To select a previously
created target explicitly, apply `target.extend(otel.withOTel())` while the
adapter is active. The extension preserves the target reference and its
existing properties.

### Queue overflow — drop newest

When `maxQueueSize` is hit, **incoming** spans are dropped. The earliest spans
in the queue survive and ship in the next batch. This matches the OpenTelemetry
JS SDK
[`BatchSpanProcessorBase`](https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/opentelemetry-sdk-trace-base/src/export/BatchSpanProcessorBase.ts)
default and aligns with the spec, which mandates dropping but leaves direction
to implementations.

Unload selection inverts this: it keeps the newest eligible spans within
the available byte budget. The asymmetry is deliberate — under
sustained overload the earliest spans likely capture the trigger, while at
unload the most recent spans are closest to the event under investigation.

### Unload flushing

Two listeners are registered:

- `visibilitychange` — flushes when `document.visibilityState === 'hidden'`.
- `pagehide` — flushes unconditionally. iOS Safari fires `pagehide` during
  bf-cache transitions without flipping `visibilityState`, so the visibility
  guard is intentionally absent here.

The default unload transport is `fetch({ keepalive: true })`. It carries your
`headers` and lets the browser continue the request after page teardown. Both
fetch and beacon remain subject to CORS; keepalive does not bypass preflight.
Delivery during unload is best effort.

Unload sends use the same single transport slot as ordinary exports and do not
retry. If the slot is busy, records stay queued. Repeated lifecycle events do
not duplicate a leased batch. Environments without a document do not start an
unload send.

Both unload transports select at most `maxBatchSize` newest queued records
within a **60 KiB UTF-8 budget**, including Resource, scope, spans and the JSON
envelope. Adapters from one loaded package copy share the remaining budget for
that document. Pending keepalive fetch bytes stay charged until response-body
settlement or cleanup, including after abort. Accepted beacon bytes stay
charged until the document is discarded: the browser provides no settlement
notification. Disposing or recreating an adapter does not reset these credits.
Other libraries share the browser's quota but are outside this counter, so the
local headroom is not a delivery guarantee.

`navigator.sendBeacon` is opt-in via `useBeacon: true` and cannot send custom
auth headers. `maxBeaconBytes` can lower its per-request limit; it cannot raise
the shared 60 KiB budget. Browser acceptance increments `beaconAccepted`, not
`exported`. Refusal or an exception counts the selected records as export
failures and releases their byte reservation.

Selection encodes each considered owned record once, newest first. An
individually oversized record is excluded; when the remaining space cannot
hold an eligible record, the older remainder is excluded. The selected records
retain their original order, with one ResourceSpans group per record. Exclusions
count as `droppedByReason.oversized`. Older records outside the leased batch
remain queued. The whole lease, including exclusions, stays held until transport
settlement or beacon handoff.

### Transport — retry and backoff

`flush` posts OTLP/JSON to `${endpoint}/v1/traces`. Per the
[OTLP spec](https://opentelemetry.io/docs/specs/otlp/#failures-1), retryable
HTTP statuses are `429`, `502`, `503`, `504`. Network errors retry too. `400`
and other non-retryable codes are surfaced immediately.

Backoff is exponential with full jitter; the `Retry-After` header (delta
seconds or HTTP-date) overrides the computed delay when present. After retries
are exhausted, a non-2xx response is **logged via `console.warn` through the
batch queue's `onError`** — the tracer never escalates failures to your app.

A 2xx response is never retried, including partial success or a malformed body.
Valid `partialSuccess.rejectedSpans` counts become export drops for the rejected
part; the remainder increments `exported`. A zero count with an error message
produces a warning without a drop. Invalid nonempty response bodies count the
sent records as export failures. Unload records excluded before sending retain
their separate `oversized` reason.

### `flush()` semantics

`await otel.flush()` waits for the queued and in-flight records present when
it is called. It does not wait for unfinished application actions or records
created later. Errors are reported through diagnostics and statistics;
`flush()` resolves even when delivery fails.

Each call has its own `exportTimeoutMs` waiting budget. Expiry reports
`flush_timeout` and stops that caller waiting; it neither aborts the shared
transport nor drops queued records. Each batch independently gets the same
time budget for sending, retry delays and response-body cleanup. A batch
deadline requests abort. The next request starts only after the previous
request and its body have settled.

`maxQueueSize` counts active spans, queued records and in-flight records
together. Admission happens before IDs and value capture; incoming spans
are dropped when capacity is exhausted. A never-settling application Promise
occupies an active slot until settlement or disposal. Telemetry does not
cancel the application. At most one fetch export runs at a time, with no
more than `maxBatchSize` records per batch. `Retry-After` is never shortened
to the local backoff cap; if it exceeds the remaining batch budget, that
batch is dropped as a timeout.

Queue sizes must be positive safe integers. Timer budgets must be finite,
positive and within the native timer range (up to 2147483647 ms). Invalid
options throw before installing the global extension.

`otel.stats()` returns `active`, `queued`, `inFlight`, `exported`, `dropped`,
`droppedByReason`, `beaconAccepted`, `flushTimeouts` and
`transportQuarantined`. The snapshot and its reason counters are immutable.
Reasons are `capacity`, `oversized`, `disposed`, `export`, `timeout` and
`observation`. `oversized` covers both record limits and available unload
byte budget; `observation` covers failures while inspecting or recording an
execution. A flush wait timeout does not itself increment
`dropped`.

An injected transport that ignores abort keeps its in-flight slot until it
actually settles. This is visible through `transportQuarantined` and one
warning; it prevents a hung transport from spawning more requests. Normal
native fetch aborts settle without entering this persistent state. A late
success cannot override an earlier batch timeout or disposal outcome.

Unload uses the same transport slot and takes at most `maxBatchSize` of the
newest queued records. If the slot is busy, records remain queued. Beacon
acceptance is a terminal handoff to the browser, counted as `beaconAccepted`,
not confirmed delivery in `exported`.

### Value capture and size limits

Enable value capture explicitly and remove sensitive data before normalization:

```ts
const otel = reatomOpentelemetry({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-app',
  captureValues: {
    redact: (key, value) => (key === 'password' ? '[redacted]' : value),
  },
})
```

Admission precedes capture. Action parameters are copied before the body;
results are copied on completion, including Promise settlement. One capture
session shares a depth limit of 2, 100 traversal slots, a 2048 UTF-16-unit
string limit and an 8192-byte budget across those snapshots. Bytes count UTF-8
JSON key/value pairs, including escaping and markers; byte arrays use base64
and int64 bigints use decimal strings for this accounting. Reservations are
conservative, so truncation may happen before the byte ceiling.

Only data descriptors are read. Application getters, `toJSON`, iterators and
coercion methods are not called; accessors become `[Skipped]`. Plain records,
arrays and byte arrays are copied; opaque objects and functions use fixed
markers. Cycles become `[Circular]`, budget exhaustion becomes `[Truncated]`.
Non-finite numbers use fixed strings, and bigints outside int64 use a fixed
`[Unsafe bigint]` marker. Native lazy Error stack accessors are omitted too;
capture does not run stack formatters. DOMException name/message are read
through their branded native getters.

Redaction and Proxy failures discard the complete span as `observation`,
without exporting the original input as a fallback. Proxy traps and redaction
are user code: output and traversal limits cannot guarantee a CPU limit or
undo their effects. `ownKeys` can also materialize all keys before the bounded
descriptor traversal. Capture should be observational, not modify application
state.

Resources use separate bounded snapshots even with value capture disabled.
Before admission to the queue, the complete record has a 16384-byte UTF-8 JSON
limit covering the encoded span, merged Resource and instrumentation scope.
Oversized records release their reservation and count once as `oversized`.
This record limit is separate from the batch envelope and unload budgets.

### `dispose()`

Stops the batch interval timer, unregisters the global extension and unload
listeners, and aborts any in-flight retry sleep so a backoff cannot post
minutes after teardown. **Does not flush.**

Safe shutdown order:

```ts
await otel.flush()
otel.dispose()
```

`dispose()` releases active and queued records immediately and requests abort
of the current export. In-flight records stay accounted for until transport
and body cleanup settle. Graceful shutdown should `await flush()` first;
resolution of `flush()` alone is not proof of delivery.

Existing instrumented targets keep their application behavior after disposal.
They no longer generate IDs, measure time, inspect values or export spans.
Pending application promises continue normally; their later completion is
ignored by the disposed adapter. Installed action middleware remains and checks
the disposed state. Promise completion callbacks remain attached until the
application Promise settles; disposal does not cancel it.

## Limitations

- Instrumentation returns the original Promise and preserves its outcome.
  Observing rejection still affects the host's `unhandledrejection` and
  `rejectionHandled` events; complete transparency of those events is not
  guaranteed. The adapter handles failures in its own observer chains.
- v1 ships **traces only** — no metrics, no logs, no W3C `traceparent`
  propagation to outgoing fetches, no offline buffering, no compression.
- Trace context is synchronous and belongs to one adapter. Async continuations
  and external callbacks need explicit `withContext` to retain an earlier
  parent. There is no automatic tracing of reactive computations or dependency
  links, and no bridge to third-party async context managers.

## Node / non-browser usage

The package itself is environment-agnostic, but a few defaults assume a
browser and turn into no-ops on Node:

- The `visibilitychange` / `pagehide` listeners are not registered when
  `document` / `window` are absent. The unload transport is irrelevant in
  Node — call `await otel.flush()` explicitly before exit.
- There is no automatic flush on process exit. Call `await otel.flush()`
  before shutting down, otherwise queued spans are lost.
- `globalThis.fetch` is required (Node ≥ 18). Inject `fetch` via the
  factory's internal option if you need a polyfill.

```ts
const otel = reatomOpentelemetry({
  endpoint: 'https://collector.example.com',
  serviceName: 'my-cli',
  version: '1.0.0',
})
try {
  // Create and run the application while tracing is installed.
  await wrap(import('./main.ts'))
} finally {
  await otel.flush()
  otel.dispose()
}
```

## Caveats for authenticated collectors

- Leave `useBeacon` at its default (`false`); beacon cannot send custom headers.
- Provide `headers: { Authorization: '...' }` and configure collector CORS.
- Unload fetch uses `keepalive: true` and the shared document budget described
  above. Neither keepalive nor beacon guarantees delivery during page teardown.
