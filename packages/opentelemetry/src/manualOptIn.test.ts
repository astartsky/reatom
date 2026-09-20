import { action, atom, bind, computed, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans, type ParsedSpan } from './test-helpers.ts'

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

test.each(['action', 'computed'] as const)(
  'manual %s opt-in re-enables a filter-rejected target exactly once',
  async (kind: 'action' | 'computed') => {
    // Uninstrumented source, constructed before the factory.
    const source = atom(1, 'mo.source')
    const { otel, spans, run } = setup()
    try {
      let bodyCalls = 0
      const makeTarget = () =>
        kind === 'action'
          ? action(() => {
              bodyCalls++
              return source() * 10
            }, 'mo.target')
          : computed(() => {
              bodyCalls++
              return source() * 10
            }, 'mo.target')
      const target = makeTarget()

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
      target.extend(otel.withOTel({ kind: 'client' }))

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
      // Wire kind is decoded by name in parseSpans ('client', not enum 2).
      expect(span.kind).toBe('client')
      // Root context: the uninstrumented source chain leaves no parent.
      expect(span.parentSpanId).toBeUndefined()
    } finally {
      otel.dispose()
    }
  },
)
