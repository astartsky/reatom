import { action, atom, bind, computed, context, notify } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans, type ParsedSpan } from './test-helpers.ts'

const setup = () => {
  const batches: ParsedSpan[][] = []
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    batches.push(parseSpans(String(init.body)))
    return new Response('{}', { status: 200 })
  })
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'execution-test',
    retry: { maxRetries: 0 },
    fetch: fetch as unknown as typeof globalThis.fetch,
  })
  const spans = () => batches.flat()
  const names = () => spans().map((span) => span.name)
  // Keep all phases in one store while the test awaits export outside it.
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  return { otel, fetch, spans, names, run }
}

test('lazy atom: init body once, cached reads emit nothing, each write emits one span', async () => {
  const { otel, fetch, spans, names, run } = setup()
  try {
    let bodyCalls = 0
    const counter = atom(() => {
      bodyCalls++
      return 7
    }, 't1.lazyCounter')

    // Actual lazy initialization: exactly one execution span.
    run(() => {
      expect(counter()).toBe(7)
    })
    await otel.flush()
    expect(names()).toEqual(['t1.lazyCounter'])
    expect(bodyCalls).toBe(1)

    // Cached repeated reads: no new execution spans, body stays cached.
    const cachedBefore = spans().length
    run(() => {
      expect(counter()).toBe(7)
      expect(counter()).toBe(7)
    })
    await otel.flush()
    expect(spans().length).toBe(cachedBefore)
    expect(bodyCalls).toBe(1)

    // First actual write: exactly one span, value and body count preserved.
    run(() => counter.set(8))
    await otel.flush()
    expect(names().filter((name) => name === 't1.lazyCounter')).toHaveLength(2)
    expect(run(counter)).toBe(8)
    expect(bodyCalls).toBe(1)

    // Equal-value write is still an actual write: exactly one more span.
    run(() => counter.set(8))
    await otel.flush()
    expect(names().filter((name) => name === 't1.lazyCounter')).toHaveLength(3)
    expect(run(counter)).toBe(8)
    expect(bodyCalls).toBe(1)
    expect(fetch).toHaveBeenCalledTimes(3)
  } finally {
    otel.dispose()
  }
})

test.each([false, true])(
  'computed: cached validation vs equal-result recompute (subscribed=%s)',
  async (subscribed: boolean) => {
    // Source is declared BEFORE the factory so it stays uninstrumented and its
    // own emissions cannot confuse observation.
    const source = atom(1, 't2.source')
    const { otel, fetch, spans, names, run } = setup()
    let detach = () => {}
    const notifications: number[] = []
    try {
      let bodyCalls = 0
      const derived = computed(() => {
        bodyCalls++
        void source() // real dependency; result stays equal across changes
        return 0
      }, 't2.derived')

      if (subscribed)
        detach = run(() =>
          derived.subscribe((value) => notifications.push(value)),
        )

      // Initial real execution.
      run(() => {
        expect(derived()).toBe(0)
      })
      await otel.flush()
      expect(names()).toEqual(['t2.derived'])
      expect(bodyCalls).toBe(1)

      // Ordinary repeated cached validation: no new span, no body call.
      const cachedBefore = spans().length
      run(() => {
        expect(derived()).toBe(0)
      })
      await otel.flush()
      expect(spans().length).toBe(cachedBefore)
      expect(bodyCalls).toBe(1)

      // Changed source with an equal computed result: a real recompute happened
      // and must be observable as exactly one execution span.
      run(() => {
        source.set(2)
        notify()
      })
      run(() => {
        expect(derived()).toBe(0)
      })
      await otel.flush()
      expect(names().filter((name) => name === 't2.derived')).toHaveLength(2)
      expect(bodyCalls).toBe(2)

      // Plain repeated read afterwards: cached again, no extra span.
      const settled = spans().length
      run(() => {
        expect(derived()).toBe(0)
      })
      await otel.flush()
      expect(spans().length).toBe(settled)
      expect(bodyCalls).toBe(2)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(notifications).toEqual(subscribed ? [0] : [])
    } finally {
      run(detach)
      run(notify)
      otel.dispose()
    }
  },
)

test('deep chain emits one span per target in a single trace with exact parent pairs', async () => {
  const { otel, spans } = setup()
  try {
    // Lazy targets declared after the factory: all instrumented.
    const leaf = atom(() => 'leaf', 't3.leaf')
    const c = computed(() => leaf(), 't3.c')
    const b = computed(() => c(), 't3.b')
    const a = computed(() => b(), 't3.a')
    const root = action(() => a(), 't3.root')

    context.start(() => {
      expect(root()).toBe('leaf')
    })
    await otel.flush()

    const emitted = spans()
    const byName = (name: string) => emitted.filter((s) => s.name === name)
    // Exact names and counts: one span each, no service/self spans.
    expect(emitted.map((s) => s.name).sort()).toEqual([
      't3.a',
      't3.b',
      't3.c',
      't3.leaf',
      't3.root',
    ])
    for (const name of ['t3.root', 't3.a', 't3.b', 't3.c', 't3.leaf']) {
      expect(byName(name)).toHaveLength(1)
    }
    const [rootSpan, aSpan, bSpan, cSpan, leafSpan] = [
      byName('t3.root')[0]!,
      byName('t3.a')[0]!,
      byName('t3.b')[0]!,
      byName('t3.c')[0]!,
      byName('t3.leaf')[0]!,
    ]
    // Single trace; the root action has no parent.
    for (const span of emitted) {
      expect(span.traceId).toBe(rootSpan!.traceId)
    }
    expect(rootSpan!.parentSpanId).toBeUndefined()
    // Exact parent pairs down the chain.
    expect(aSpan!.parentSpanId).toBe(rootSpan!.spanId)
    expect(bSpan!.parentSpanId).toBe(aSpan!.spanId)
    expect(cSpan!.parentSpanId).toBe(bSpan!.spanId)
    expect(leafSpan!.parentSpanId).toBe(cSpan!.spanId)
  } finally {
    otel.dispose()
  }
})
