# Real applications and an OTLP Collector

This separate suite runs the original tree, tic-tac-toe and React search
applications as minified production builds. A test bootstrap creates the
adapter before importing each original entrypoint. All framework imports
resolve to the same built `@reatom/core`; the build records and checks that
resolution. The harness does not rewrite application models, components or the
core.

The assertions cover the adapter's actions-only contract:

- Recursive tree actions keep their synchronous parent relationships.
- Tic-tac-toe retains moves, occupied-cell guards, win/reset and computer play.
  Ordinary `wrap` does not propagate the adapter's context. The asynchronous
  computer response therefore starts a separate trace. An additional explicit
  `withContext` boundary calls the application's original reset action after
  `await wrap` and verifies its saved parent.
- Search keeps query/filter/pagination, stale-response handling and recovery.
  The bootstrap explicitly traces the original cached request Promise; it does
  not replace the resource computation or claim automatic computed spans.
  Error status and redaction are checked on the original HTTP 503 rejection.
- Native CORS and navigation exercise real browser transport. Only the two
  application GitHub API endpoints are served by deterministic local fixtures.
  OTLP requests use the real browser fetch and Collector receiver.

API routes are removed before export and navigation: Playwright automatically
answers preflight while routing is enabled, even for unmatched URLs. Transport
checks therefore run without request interception. After navigation the runner
waits for Collector receipt before closing the BrowserContext. Chromium NetLog
records outgoing socket bytes and flushes them when the browser closes; this
also exposes Blob beacon bodies that CDP loses during navigation. The runner
then checks the exact outgoing IDs against the Collector and checks ordinary
fetch bodies against both CDP and NetLog. The parser deliberately supports only
this isolated HTTP/1.1 fixture with Content-Length framing. NetLog captures full
synthetic request data and must not be used with a personal browser profile.

There are no reactive write spans, automatic dependency links or implicit
asynchronous trace propagation. Those belong to the abandoned core-modifying
design and are not represented as passing checks here.

## Prepare separately

Docker must already be running. Preparation may download the public images
pinned in `images.json`; the test command never pulls or installs anything.
The pinned platform is `linux/arm64`. The runner image contains matching
Playwright and Chromium versions. No repository content is sent to a registry.

From the workspace root, install the existing frozen workspace dependencies
and build the packages used by the applications:

```sh
pnpm install --frozen-lockfile
pnpm --filter @reatom/core --filter @reatom/jsx --filter @reatom/react --filter @reatom/opentelemetry build
node packages/opentelemetry/e2e/collector/build-apps.mjs
node packages/opentelemetry/e2e/collector/prepare-images.mjs
```

Then run the standalone oracle tests and the complete integration suite:

```sh
pnpm --filter @reatom/opentelemetry test:e2e:collector:oracle
pnpm --filter @reatom/opentelemetry test:e2e:collector
```

The Compose project uses an internal network with no published ports, host
networking or Docker socket. Test scripts and built applications are mounted
read-only. Only a fresh artifacts directory is writable. Cleanup affects that
run's project and preserves its evidence.

The host stops the Collector gracefully before running the final verification;
it does not restart the file exporter. Assertions read the Collector's JSONL,
not its logs or HTTP status alone. The independent oracle checks IDs, complete
parent graphs, status, privacy, resources, durations and exact delivered ID sets
against passive request observations. The receiver control proves that the
file exporter and decoder work. Disabled instrumentation and an unavailable
receiver are negative controls, not successful empty traces.

Each run keeps raw Collector records, native NetLog, request bodies, app outcomes, semantic
graphs, logs and version/build information under its artifacts directory.
Compare two successful clean runs with:

```sh
node packages/opentelemetry/e2e/collector/compare-runs.mjs FIRST_ARTIFACTS SECOND_ARTIFACTS
```

Dynamic IDs and timestamps are validated before semantic comparison; only the
per-run resource identifier is removed by the comparison command. Missing
images, app failures, invalid JSONL and timeouts fail the command explicitly.
The host also rejects stale app inputs, package builds and lockfiles before
starting Docker; rebuilding an input requires rebuilding the application bundle.
