import {
  type Atom,
  atom,
  bind,
  computed,
  context,
  notify,
  withComputed,
} from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import type { SpanContext } from './spanContext.ts'

test.each(['left', 'right'] as const)(
  'retains the %s write cause through a silent cycle copy',
  async (side: 'left' | 'right') => {
    const spans: Array<SpanContext & { name: string; links?: SpanContext[] }> =
      []
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'cycle-links',
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        const payload = JSON.parse(String(init?.body))
        for (const resource of payload.resourceSpans)
          for (const scope of resource.scopeSpans) spans.push(...scope.spans)
        return new Response(null)
      },
    })
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    let phase = 'initial',
      detach = () => {}
    const starts: Array<{ side: string; phase: string; context: SpanContext }> =
      []
    const writes: Partial<Record<'left' | 'right', SpanContext>> = {}
    const calls = { left: 0, right: 0, consumer: 0 }
    const notifications: number[] = []
    const enter = (side: 'left' | 'right') => {
      calls[side]++
      starts.push({ side, phase, context: otel.getCurrentContext()! })
    }
    try {
      const left: Atom<number> = atom(0, 'cycle.left').extend(
        withComputed(() => {
          enter('left')
          return right() / 2
        }),
      )
      const right: Atom<number> = atom(0, 'cycle.right').extend(
        withComputed(() => {
          enter('right')
          return left() * 2
        }),
      )
      const consumer = computed(() => {
        calls.consumer++
        return left() + right()
      }, 'cycle.consumer')
      detach = run(() =>
        consumer.subscribe((value) => notifications.push(value)),
      )
      run(notify)
      phase = 'left-write'
      run(() =>
        left.set(() => {
          writes.left = otel.getCurrentContext()!
          return 3
        }),
      )
      run(notify)
      expect(run(() => [left(), right(), consumer()])).toEqual([3, 6, 9])
      phase = 'right-write'
      run(() =>
        right.set(() => {
          writes.right = otel.getCurrentContext()!
          return 10
        }),
      )
      run(notify)
      expect(run(() => [left(), right(), consumer()])).toEqual([5, 10, 15])
      expect(calls).toEqual({ left: 3, right: 3, consumer: 3 })
      expect(notifications).toEqual([0, 9, 15])
      await otel.flush()
      expect(spans).toHaveLength(11)
      expect(otel.stats()).toMatchObject({ exported: 11, dropped: 0 })
      const changed = starts.filter(
        (entry) => entry.side !== side && entry.phase === `${side}-write`,
      )
      expect(changed).toHaveLength(1)
      const execution = spans.find(
        (span) => span.spanId === changed[0]!.context.spanId,
      )!
      const write = spans.find((span) => span.spanId === writes[side]!.spanId)!
      expect(write).toBeDefined()
      expect(execution).toBeDefined()
      expect(execution.links ?? []).toContainEqual({
        traceId: write.traceId,
        spanId: write.spanId,
      })
    } finally {
      run(detach)
      run(notify)
      otel.dispose()
    }
  },
)
