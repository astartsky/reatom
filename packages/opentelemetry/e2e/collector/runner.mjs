/* global process, console, URL, fetch */

import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { readHttpRequests } from './netlog.mjs'
import { decodeJsonl, verifyCase, verifyDelivery } from './oracle.mjs'
import * as scenarios from './scenarios.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = resolve(process.env.COLLECTOR_ARTIFACTS ?? '/artifacts')
const apps = resolve(process.env.COLLECTOR_APPS ?? join(here, 'prepared/apps'))
const traces = join(artifacts, 'collector/traces.jsonl')
const output = join(artifacts, 'run.json')
const netlogPath = join(artifacts, 'netlog.json')
const json = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n')

const requiredCases = [
  ...[
    'E01-tree7',
    'E02-xo-human',
    'E03-xo-ai',
    'E04-search',
    'E05-search-recovery',
  ].flatMap((name) => [`${name}-raw`, `${name}-traced`]),
  'E05-search-capture',
  'E06-offline',
  'E06-cors-denied',
  'E06-unload-keepalive',
  'E06-unload-beacon',
]

const verifyBuild = async () => {
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
  const manifest = JSON.parse(
    await readFile(join(apps, 'manifest.json'), 'utf8'),
  )
  assert.equal(
    digest(await readFile(join(here, 'build-apps.mjs'))),
    manifest.buildConfigHash,
    'stale app build configuration',
  )
  for (const [name, expected] of Object.entries(manifest.outputs)) {
    const file = resolve(apps, name)
    assert(file.startsWith(apps + sep), 'invalid build manifest path')
    assert.equal(
      digest(await readFile(file)),
      expected,
      `app build changed: ${name}`,
    )
  }
  return manifest
}

const poll = async (callback, label, timeout = 15000) => {
  const until = Date.now() + timeout
  let last
  while (Date.now() < until) {
    try {
      const result = await callback()
      if (result) return result
    } catch (error) {
      if (
        error.code !== 'ENOENT' &&
        error.code !== 'ECONNREFUSED' &&
        !(error instanceof TypeError)
      )
        throw error
      last = error
    }
    await delay(50)
  }
  throw new Error(`Timed out: ${label}`, { cause: last })
}

const readSpans = async (final) =>
  decodeJsonl(await readFile(traces, 'utf8'), { final })

const verifyWireCapture = async (run, attachBeacon = false) => {
  const requests = readHttpRequests(
    JSON.parse(await readFile(netlogPath, 'utf8')),
  ).filter(
    (request) =>
      request.headers.host === 'collector:4318' &&
      request.method === 'POST' &&
      request.target === '/v1/traces',
  )
  const bodies = new Map(run.cases.map((item) => [item.caseId, []]))
  for (const request of requests) {
    const spans = decodeJsonl(request.body)
    assert(spans.length > 0, 'empty outgoing OTLP request')
    const caseId = spans[0].resource['test.case_id']
    assert(bodies.has(caseId), 'unexpected outgoing case')
    for (const span of spans) {
      assert.equal(
        span.resource['test.case_id'],
        caseId,
        'mixed outgoing cases',
      )
      assert.equal(
        span.resource['test.run_id'],
        run.runId,
        'cross-run outgoing record',
      )
    }
    bodies.get(caseId).push(request.body)
  }
  for (const item of run.cases) {
    const sent = bodies.get(item.caseId)
    const shouldDeliver = item.mode !== 'raw' && item.deliveryExpected !== false
    if (!shouldDeliver) {
      assert.equal(sent.length, 0, `unexpected native send: ${item.caseId}`)
      continue
    }
    assert(sent.length > 0, `missing native send: ${item.caseId}`)
    if (attachBeacon && item.wireCapture === 'netlog') {
      assert.equal(
        sent.length,
        item.wireRequests.length,
        'beacon request count',
      )
      item.wireBodies = sent
    }
    assert.deepEqual(
      [...sent].sort(),
      [...item.wireBodies].sort(),
      `wire body mismatch: ${item.caseId}`,
    )
  }
  return requests
}

const verify = (spans, run) => {
  const caseIds = run.cases.map((item) => item.caseId)
  assert(caseIds.length > 0, 'no application scenarios ran')
  assert.equal(new Set(caseIds).size, caseIds.length, 'duplicate case IDs')
  if (!run.caseFilter)
    assert.deepEqual(
      [...caseIds].sort(),
      [...requiredCases].sort(),
      'incomplete application scenarios',
    )
  const allowed = new Set([
    'receiver-control',
    ...run.cases.map((item) => item.caseId),
  ])
  for (const span of spans) {
    assert(
      allowed.has(span.resource['test.case_id']),
      'unexpected case in Collector',
    )
    assert.equal(
      span.resource['test.run_id'],
      run.runId,
      'cross-run Collector record',
    )
  }
  verifyCase(spans, {
    caseId: 'receiver-control',
    serviceName: 'collector-control',
    expectedCount: 1,
    requiredNames: ['receiver.control'],
  })
  verifyDelivery(
    spans.filter(
      (span) => span.resource['test.case_id'] === 'receiver-control',
    ),
    run.control,
  )
  const semantic = {}
  for (const item of run.cases) {
    const received = spans.filter(
      (span) => span.resource['test.case_id'] === item.caseId,
    )
    const wire = item.wireBodies.flatMap((body) => decodeJsonl(body))
    const shouldDeliver = item.mode !== 'raw' && item.deliveryExpected !== false
    if (shouldDeliver) verifyDelivery(received, wire)
    else {
      assert.equal(received.length, 0, `unexpected delivery: ${item.caseId}`)
      if (item.mode === 'raw')
        assert.equal(wire.length, 0, 'raw app emitted OTLP')
      // A disabled adapter/receiver must fail the positive span requirement.
      assert.throws(
        () =>
          verifyCase(spans, {
            caseId: item.caseId,
            serviceName: `collector-${item.app}`,
          }),
        /missing case spans/,
      )
    }
    semantic[item.caseId] = verifyCase(spans, {
      caseId: item.caseId,
      serviceName: `collector-${item.app}`,
      scopeName: '@reatom/opentelemetry',
      privateSentinels: ['PRIVATE_FIXTURE'],
      ...(shouldDeliver ? item.expectation : { expectedCount: 0 }),
    })
  }
  scenarios.verifyScenarios?.(spans, run.cases)
  return semantic
}

const serve = async (port) => {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://runner').pathname
      if (path === '/blank') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<!doctype html><title>Finished</title>')
        return
      }
      const file = resolve(
        apps,
        '.' + path,
        path.endsWith('/') ? 'index.html' : '',
      )
      assert(file.startsWith(apps + sep), 'outside app root')
      response.setHeader(
        'Content-Type',
        {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.svg': 'image/svg+xml',
        }[extname(file)] ?? 'application/octet-stream',
      )
      response.end(await readFile(file))
    } catch {
      response.statusCode = 404
      response.end('Not found')
    }
  })
  await new Promise((resolve, reject) =>
    server.once('error', reject).listen(port, '0.0.0.0', resolve),
  )
  return server
}

const execute = async () => {
  await mkdir(artifacts, { recursive: true })
  const manifest = await verifyBuild()
  const runId = process.env.COLLECTOR_RUN_ID ?? randomBytes(12).toString('hex')
  await poll(
    async () => (await fetch('http://collector:13133/')).ok,
    'Collector health',
  )
  const start = String(BigInt(Date.now()) * 1000000n)
  const controlBody = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: 'service.name',
              value: { stringValue: 'collector-control' },
            },
            { key: 'test.case_id', value: { stringValue: 'receiver-control' } },
            { key: 'test.run_id', value: { stringValue: runId } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'independent-receiver-control' },
            spans: [
              {
                name: 'receiver.control',
                traceId: randomBytes(16).toString('hex'),
                spanId: randomBytes(8).toString('hex'),
                kind: 1,
                startTimeUnixNano: start,
                endTimeUnixNano: start,
              },
            ],
          },
        ],
      },
    ],
  })
  const control = decodeJsonl(controlBody)
  const response = await fetch('http://collector:4318/v1/traces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: controlBody,
  })
  assert(response.ok, `Collector control status ${response.status}`)
  await response.text()
  await poll(
    async () =>
      (await readSpans(false)).some(
        (span) => span.spanId === control[0].spanId,
      ),
    'receiver control JSONL',
  )

  const servers = []
  let browser
  try {
    servers.push(await serve(4173), await serve(4174))
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        `--log-net-log=${netlogPath}`,
        '--net-log-capture-mode=Everything',
      ],
    })
    const cases = await scenarios.runScenarios({
      browser,
      origin: 'http://runner:4173',
      runId,
      artifactDirectory: artifacts,
      caseFilter: process.env.COLLECTOR_CASE,
      waitForDelivery: async (bodies) => {
        const wire = bodies.flatMap((body) => decodeJsonl(body))
        assert(wire.length > 0, 'unload must expose sent IDs')
        await poll(async () => {
          const received = new Set(
            (await readSpans(false)).map(
              (span) => `${span.traceId}/${span.spanId}`,
            ),
          )
          return wire.every((span) =>
            received.has(`${span.traceId}/${span.spanId}`),
          )
        }, 'unload IDs in Collector')
      },
      waitForCaseDelivery: async (caseId, count) => {
        await poll(
          async () =>
            (await readSpans(false)).filter(
              (span) =>
                span.resource['test.run_id'] === runId &&
                span.resource['test.case_id'] === caseId,
            ).length >= count,
          `unload receipt: ${caseId}`,
        )
      },
    })
    const run = {
      runId,
      caseFilter: process.env.COLLECTOR_CASE,
      control,
      cases,
      browserVersion: browser.version(),
      manifest,
    }
    // Native NetLog flushes only when Chromium closes. No request interception
    // or application transport replacement is involved in this body capture.
    await browser.close()
    browser = undefined
    await json(
      join(artifacts, 'outgoing-http.json'),
      await verifyWireCapture(run, true),
    )
    await json(output, run)
    const expected =
      1 +
      cases
        .filter(
          (item) => item.mode !== 'raw' && item.deliveryExpected !== false,
        )
        .flatMap((item) => item.wireBodies.flatMap((body) => decodeJsonl(body)))
        .length
    const spans = await poll(async () => {
      const current = await readSpans(false)
      return current.length >= expected ? current : undefined
    }, 'all expected Collector records')
    await json(
      join(artifacts, 'semantic-before-shutdown.json'),
      verify(spans, run),
    )
    console.log(
      JSON.stringify({
        phase: 'run',
        cases: cases.length,
        spans: spans.length,
      }),
    )
  } finally {
    await browser?.close()
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections()
            server.close(resolve)
          }),
      ),
    )
  }
}

try {
  if (process.argv[2] === 'run') await execute()
  else if (process.argv[2] === 'verify') {
    await verifyBuild()
    const run = JSON.parse(await readFile(output, 'utf8'))
    await verifyWireCapture(run)
    const spans = await readSpans(true)
    const semantic = verify(spans, run)
    await json(join(artifacts, 'semantic.json'), semantic)
    await json(join(artifacts, 'verified.json'), {
      runId: run.runId,
      spans: spans.length,
      cases: run.cases.length,
    })
    console.log(
      JSON.stringify({
        phase: 'verify',
        cases: run.cases.length,
        spans: spans.length,
      }),
    )
  } else throw new Error('Usage: runner.mjs run|verify')
} catch (error) {
  await mkdir(artifacts, { recursive: true })
  await json(join(artifacts, `failure-${process.argv[2]}.json`), {
    error: String(error),
    stack: error.stack,
  })
  throw error
}
