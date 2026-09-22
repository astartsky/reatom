import { action, bind, context, wrap } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import type { ReatomOpentelemetry } from './reatomOpentelemetry.ts'
import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import type { SpanContext } from './spanContext.ts'
import { parsePayload, parseSpans } from './test-helpers.ts'

const createRun = () =>
  context.start(() => bind(<T>(callback: () => T) => callback()))

const setup = (input: {
  filter: (name: string) => boolean
  captureValues?: false | { redact?: (key: string, value: unknown) => unknown }
}) => {
  const bodies: string[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'capture-no-core',
    retry: { maxRetries: 0 },
    maxBatchSize: 100,
    filter: (target) => input.filter(target.name),
    ...(input.captureValues === undefined
      ? {}
      : { captureValues: input.captureValues }),
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response('{}', { status: 200 })
    },
  })
  return { otel, bodies, run: createRun() }
}

test.each(['sync', 'async'] as const)(
  '%s admission owns Resource before body mutation and completion',
  async (mode: 'sync' | 'async') => {
    const name = `capture.resource.${mode}`
    const { otel, bodies, run } = setup({
      filter: (candidate) => candidate === name,
    })
    const gate = Promise.withResolvers<void>()
    const tenant = { phase: 'capture-resource-admission' }
    const bytes = new Uint8Array([1, 2, 3])
    const resource = { tenant, bytes }
    const value = { result: 'capture-resource-result' }
    let original: Promise<typeof value> | undefined
    let bodyCalls = 0
    try {
      const save = action(() => {
        bodyCalls++
        tenant.phase = 'capture-resource-body'
        bytes.fill(8)
        if (mode === 'sync') return value
        const result = (async () => {
          await wrap(gate.promise)
          return value
        })()
        original = result
        return result
      }, name)

      const returned = run(() => resourceAttributesVar.run(resource, save))
      expect(returned).toBe(mode === 'async' ? original : value)
      expect(bodyCalls).toBe(1)
      expect(otel.stats()).toMatchObject({
        active: mode === 'sync' ? 0 : 1,
        queued: mode === 'sync' ? 1 : 0,
        inFlight: 0,
        exported: 0,
        dropped: 0,
      })
      expect(tenant.phase).toBe('capture-resource-body')
      expect([...bytes]).toEqual([8, 8, 8])
      tenant.phase = 'capture-resource-completion'
      bytes.fill(9)
      gate.resolve()
      expect(await returned).toBe(value)
      await otel.flush()

      expect(bodies).toHaveLength(1)
      expect(bodies.join('')).toContain('capture-resource-admission')
      expect(bodies.join('')).not.toContain('capture-resource-body')
      expect(bodies.join('')).not.toContain('capture-resource-completion')
      const [exported] = parsePayload(bodies[0]!).resourceSpans
      expect(exported!.spans.map((span) => span.name)).toEqual([name])
      const attributes = exported!.resource.attributes
      expect(attributes.tenant).toEqual({
        phase: 'capture-resource-admission',
      })
      expect(attributes.bytes).toEqual({ bytes: 'AQID' })
      expect(otel.stats()).toMatchObject({
        active: 0,
        queued: 0,
        inFlight: 0,
        exported: 1,
        dropped: 0,
      })
    } finally {
      gate.resolve()
      await original
      otel.dispose()
    }
  },
)

test('redacting params may dispose telemetry without changing the body/result or capturing completion', async () => {
  const bodies: string[] = []
  const run = createRun()
  const result = { result: 'capture-dispose-result' }
  const redacted: string[] = []
  const random = vi.spyOn(crypto, 'getRandomValues')
  let idCallsAfterDispose = -1
  let otel: ReatomOpentelemetry | undefined
  let bodyCalls = 0
  let bodyContext: SpanContext | undefined
  let positive: ReturnType<typeof setup> | undefined
  try {
    otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'capture-no-core',
      retry: { maxRetries: 0 },
      maxBatchSize: 100,
      filter: (target) => target.name === 'capture.dispose.redact',
      captureValues: {
        redact(key, value) {
          redacted.push(key)
          if (key === 'params') {
            otel!.dispose()
            idCallsAfterDispose = random.mock.calls.length
          }
          return value
        },
      },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response('{}', { status: 200 })
      },
    })
    const target = action(() => {
      bodyCalls++
      bodyContext = otel!.getCurrentContext()
      return result
    }, 'capture.dispose.redact')

    expect(run(target)).toBe(result)
    expect(bodyCalls).toBe(1)
    expect(redacted).toEqual(['params'])
    // Disposal released admission before allocating any span or parent IDs.
    expect(idCallsAfterDispose).toBe(0)
    expect(random).not.toHaveBeenCalled()
    expect(bodyContext).toBeUndefined()
    expect(run(otel.getCurrentContext)).toBeUndefined()
    await otel.flush()
    expect(bodies).toEqual([])
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      dropped: 1,
      droppedByReason: { disposed: 1, observation: 0 },
    })

    positive = setup({
      filter: (name) => name === 'capture.dispose.positive',
    })
    const next = action(
      () => ({ result: 'capture-dispose-positive' }),
      'capture.dispose.positive',
    )
    expect(positive.run(next)).toEqual({ result: 'capture-dispose-positive' })
    await positive.otel.flush()
    expect(positive.bodies).toHaveLength(1)
    expect(parseSpans(positive.bodies[0]!).map((span) => span.name)).toEqual([
      'capture.dispose.positive',
    ])
  } finally {
    otel?.dispose()
    positive?.otel.dispose()
    random.mockRestore()
  }
})
