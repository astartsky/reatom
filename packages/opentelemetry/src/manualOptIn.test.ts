import { action, atom, bind, computed, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { type ParsedSpan, parseSpans } from './test-helpers.ts'

const setup = () => {
  const batches: ParsedSpan[][] = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    batches.push(parseSpans(String(init?.body)))
    return new Response('{}', { status: 200 })
  })
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'manual-opt-in',
    filter: () => false, // reject every auto-instrumentation target
    retry: { maxRetries: 0 },
    fetch,
  })
  const spans = () => batches.flat()
  // One store for the whole test; exports are awaited outside it.
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  return { otel, spans, run }
}

test('manual opt-in instruments a previously untouched filtered action exactly once', async () => {
  // Uninstrumented source, constructed before the factory.
  const source = atom(1, 'mo.source')
  const raw = action(() => 0, 'mo.raw')
  const { otel, spans, run } = setup()
  try {
    let bodyCalls = 0
    const target = action(() => {
      bodyCalls++
      return source() * 10
    }, 'mo.target')
    expect(target.__reatom.middlewares).toHaveLength(
      raw.__reatom.middlewares.length,
    )

    // First real execution while filter-rejected: value correct, zero spans.
    let first = -1
    run(() => {
      first = target()
    })
    expect(first).toBe(10)
    expect(bodyCalls).toBe(1)
    await otel.flush()
    expect(spans()).toHaveLength(0)

    // Manual opt-in applied TWICE to the SAME target.
    target.extend(otel.withOTel({ kind: 'client' }))
    target.extend(otel.withOTel({ kind: 'producer' }))

    // Second ACTUAL execution: value/body preserved, exactly one span.
    let second = -1
    run(() => {
      source.set(2)
      second = target()
    })
    expect(second).toBe(20)
    expect(bodyCalls).toBe(2)
    await otel.flush()
    expect(spans()).toHaveLength(1)
    const span = spans()[0]!
    expect(span.name).toBe('mo.target')
    // Wire kind is decoded by name in parseSpans; the later override wins.
    expect(span.kind).toBe('producer')
    // Root context: the uninstrumented source chain leaves no parent.
    expect(span.parentSpanId).toBeUndefined()

    const bridge = action(() => target(), 'mo.filteredBridge')
    expect(bridge.__reatom.middlewares).toHaveLength(
      raw.__reatom.middlewares.length,
    )
    expect(run(() => otel.startTrace('manual-root', bridge))).toBe(20)
    expect(bodyCalls).toBe(3)
    await otel.flush()
    const [child, root] = spans().slice(1)
    expect(spans()).toHaveLength(3)
    expect([child!.name, root!.name]).toEqual(['mo.target', 'manual-root'])
    expect(child!.parentSpanId).toBe(root!.spanId)
    expect(child!.traceId).toBe(root!.traceId)
  } finally {
    otel.dispose()
  }
})

test('extending atoms and computeds with withOTel leaves them unchanged', async () => {
  const { otel, spans, run } = setup()
  try {
    const source = atom(1, 'mo.atomTarget')
    const derived = computed(() => source() + 1, 'mo.computedTarget')
    expect(source.extend(otel.withOTel())).toBe(source)
    expect(derived.extend(otel.withOTel())).toBe(derived)

    run(() => source.set(2))
    expect(run(derived)).toBe(3)
    await otel.flush()
    expect(spans()).toHaveLength(0)
  } finally {
    otel.dispose()
  }
})
