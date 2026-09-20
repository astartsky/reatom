import { action, atom, bind, context, withComputed, wrap } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import type { SpanContext } from './spanContext.ts'
import { parseSpans, type ParsedSpan } from './test-helpers.ts'

test.each([false, true])(
  'async transforms on one frame retain each execution context (reverse=%s)',
  async (reverse: boolean) => {
    const spans: ParsedSpan[] = []
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'continuation-test',
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        spans.push(...parseSpans(String(init?.body)))
        return new Response(null)
      },
    })
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    const gates = [
      Promise.withResolvers<number>(),
      Promise.withResolvers<number>(),
    ]
    const entered: SpanContext[] = []
    const resumed: Array<SpanContext | undefined> = []
    const results: Promise<number>[] = []
    let armed = false
    try {
      const children = [
        action(() => 10, 'child-0'),
        action(() => 20, 'child-1'),
      ]
      const value = atom(Promise.resolve(0), 'value').extend(
        withComputed((state) => {
          if (!armed) return state
          const index = entered.length
          entered.push(otel.getCurrentContext()!)
          const result = (async () => {
            const resolved = await wrap(gates[index]!.promise)
            resumed[index] = otel.getCurrentContext()
            children[index]!()
            return resolved
          })()
          results.push(result)
          return result
        }),
      )
      await run(value)
      await otel.flush()
      spans.length = 0
      armed = true
      const result = run(() => value.set(Promise.resolve(5)))
      expect(entered).toHaveLength(2)
      expect(entered[0]!.spanId).not.toBe(entered[1]!.spanId)
      expect(result).toBe(results[1])
      for (const index of reverse ? [1, 0] : [0, 1]) {
        gates[index]!.resolve(index + 1)
        expect(await results[index]).toBe(index + 1)
      }
      await otel.flush()
      expect(spans.map((span) => span.name).sort()).toEqual([
        'child-0',
        'child-1',
        'value',
        'value',
        'value',
      ])
      expect(resumed).toEqual(entered)
      for (let index = 0; index < 2; index++) {
        const execution = spans.find(
          (span) => span.spanId === entered[index]!.spanId,
        )!
        const child = spans.find((span) => span.name === `child-${index}`)!
        expect(execution.parentSpanId).toBeUndefined()
        expect(child.parentSpanId).toBe(execution.spanId)
        expect(child.traceId).toBe(execution.traceId)
      }
    } finally {
      gates.forEach((gate) => gate.resolve(0))
      await Promise.allSettled(results)
      otel.dispose()
    }
  },
)
