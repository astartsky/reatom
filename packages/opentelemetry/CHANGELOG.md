## 1000.15.2 (2026-04-27)

### Feat

- **opentelemetry**: initial release. Action tracing through public Reatom
  middleware, explicit `startTrace` / `withContext` boundaries, metadata-only
  defaults and opt-in value capture. Batched OTLP/HTTP JSON export supports
  retry/backoff and partial success. Unload uses bounded keepalive fetch by
  default, with optional `navigator.sendBeacon`. No changes to `@reatom/core`,
  reactive spans, automatic dependency links or implicit async trace context.
  Ships traces only, without an SDK dependency, metrics or offline buffering.
