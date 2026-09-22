import {
  action,
  atom,
  bind,
  computed,
  context,
  notify,
  top,
} from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

const runInStore = () => context.start(() => bind(<T>(fn: () => T) => fn()))
const make = (
  options: Partial<Parameters<typeof reatomOpentelemetry>[0]> = {},
) => {
  const bodies: string[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'no-core',
    batchInterval: 60000,
    maxBatchSize: 100,
    retry: { maxRetries: 0 },
    ...options,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response('{}')
    },
  })
  return { bodies, otel }
}

test('sync root/action nesting exports actual spans and preserves values and identities', async () => {
  const { bodies, otel } = make()
  const run = runInStore()
  const result = { privateValue: 'private-payload' }
  let calls = 0
  const child = action((input: typeof result) => {
    calls++
    return input
  }, 'child')
  const parent = action(() => child(result), 'parent')
  try {
    expect(run(() => otel.startTrace('root', parent))).toBe(result)
    expect(calls).toBe(1)
    expect(otel.getCurrentContext()).toBeUndefined()
    await otel.flush()
    const spans = bodies.flatMap(parseSpans)
    expect(spans.map((s) => s.name).sort()).toEqual(['child', 'parent', 'root'])
    const root = spans.find((s) => s.name === 'root')!
    const outer = spans.find((s) => s.name === 'parent')!
    const inner = spans.find((s) => s.name === 'child')!
    expect(outer.parentSpanId).toBe(root.spanId)
    expect(inner.parentSpanId).toBe(outer.spanId)
    expect(new Set(spans.map((s) => s.traceId)).size).toBe(1)
    expect(bodies.join('')).not.toContain('private-payload')
    expect(spans.every((s) => s.startTimeUnixNano <= s.endTimeUnixNano)).toBe(
      true,
    )
    expect(otel.stats()).toMatchObject({
      exported: 3,
      dropped: 0,
      active: 0,
      queued: 0,
      inFlight: 0,
    })
  } finally {
    otel.dispose()
  }
})

test('plain atoms stay lazy and reactive bodies/notifications match without tracing their reads', async () => {
  const evaluate = (traced: boolean) => {
    const run = runInStore()
    const fixture = traced ? make() : undefined
    let initCalls = 0,
      computeCalls = 0
    const source = atom(() => {
      initCalls++
      return 1
    }, 'state')
    const derived = computed(() => {
      computeCalls++
      return source() * 2
    }, 'derived')
    const pipeline = Object.getOwnPropertyDescriptor(
      source.__reatom,
      'pipeline',
    )?.value
    expect(pipeline).not.toBeUndefined()
    if (fixture) source.extend(fixture.otel.withOTel())
    expect(
      Object.getOwnPropertyDescriptor(source.__reatom, 'pipeline')?.value,
    ).toBe(pipeline)
    expect(initCalls).toBe(0)
    const notices: number[] = []
    let off = () => {}
    try {
      const values = run(() => {
        const first = derived()
        const cached = derived()
        off = derived.subscribe((value) => notices.push(value))
        source.set(3)
        notify()
        return [first, cached, derived()]
      })
      return { fixture, values, notices, initCalls, computeCalls }
    } finally {
      run(off)
    }
  }
  const raw = evaluate(false),
    traced = evaluate(true)
  try {
    const expected = {
      values: [2, 2, 6],
      notices: [2, 6],
      initCalls: 1,
      computeCalls: 2,
    }
    expect(raw).toMatchObject(expected)
    expect(traced).toMatchObject(expected)
    await traced.fixture!.otel.flush()
    expect(traced.fixture!.bodies.flatMap(parseSpans)).toEqual([])
  } finally {
    traced.fixture!.otel.dispose()
  }
})

test('opt-in capture, admission and subsequent export reuse the actual queue', async () => {
  const { otel, bodies } = make({ captureValues: {}, maxQueueSize: 1 })
  const run = runInStore()
  const value = { message: 'captured' }
  const send = action((input: typeof value) => input, 'send')
  try {
    expect(run(() => send(value))).toBe(value)
    expect(run(() => send(value))).toBe(value)
    await otel.flush()
    expect(bodies.flatMap(parseSpans)).toHaveLength(1)
    expect(bodies.join('')).toContain('captured')
    expect(otel.stats()).toMatchObject({
      exported: 1,
      dropped: 1,
      active: 0,
      queued: 0,
      inFlight: 0,
    })
    expect(run(() => send(value))).toBe(value)
    await otel.flush()
    expect(bodies.flatMap(parseSpans)).toHaveLength(2)
    expect(otel.stats()).toMatchObject({ exported: 2, dropped: 1 })
  } finally {
    otel.dispose()
  }
})

test('adapter never adds private observation or continuation metadata to original core', async () => {
  const { otel } = make()
  const run = runInStore()
  let frameKeys: string[] = []
  let contextKeys: string[] = []
  const target = action(() => {
    frameKeys = Object.getOwnPropertyNames(top()).filter(
      (key) => key.includes('continuation') || key.includes('observation'),
    )
    contextKeys = Object.getOwnPropertyNames(context).filter(
      (key) => key.includes('continuation') || key.includes('observation'),
    )
  }, 'private-metadata')
  try {
    run(() => otel.startTrace('metadata-root', target))
    expect(frameKeys).toEqual([])
    expect(contextKeys).toEqual([])
    await otel.flush()
  } finally {
    otel.dispose()
  }
})
