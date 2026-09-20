import {
  action,
  type Atom,
  atom,
  bind,
  computed,
  context,
  withComputed,
  wrap,
} from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import type { SpanContext } from './spanContext.ts'

interface WireSpan extends SpanContext {
  name: string
  parentSpanId?: string
  links?: SpanContext[]
}
const pair = ({ traceId, spanId }: SpanContext): SpanContext => ({
  traceId,
  spanId,
})
const setup = (filter: (target: { name: string }) => boolean = () => true) => {
  const spans: WireSpan[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'links-lifecycle',
    filter,
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init?.body))
      spans.push(
        ...payload.resourceSpans.flatMap(
          (resource: { scopeSpans: { spans: WireSpan[] }[] }) =>
            resource.scopeSpans.flatMap((scope) => scope.spans),
        ),
      )
      return new Response(null)
    },
  })
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  return { spans, otel, run }
}

test('filtered input execution does not borrow its traced parent as a cause', async () => {
  const { spans, otel, run } = setup((target) => target.name !== 'links.hidden')
  try {
    const source = atom(1, 'links.hidden')
    let calls = 0
    const consumer = computed(() => {
      calls++
      return source() * 2
    }, 'links.consumer')
    const write = action(() => source.set(2), 'links.write')
    expect(run(consumer)).toBe(2)
    expect(run(write)).toBe(2)
    expect(run(consumer)).toBe(4)
    await otel.flush()
    expect(calls).toBe(2)
    expect(spans.filter((span) => span.name === 'links.hidden')).toEqual([])
    expect(spans.filter((span) => span.name === 'links.write')).toHaveLength(1)
    const consumers = spans.filter((span) => span.name === 'links.consumer')
    expect(consumers).toHaveLength(2)
    expect(consumers.map((span) => span.links ?? [])).toEqual([[], []])
  } finally {
    otel.dispose()
  }
})

test.each([false, true])(
  'async completion retains sync input pairs (reverse=%s)',
  async (reverse: boolean) => {
    const { spans, otel, run } = setup()
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const pending: Promise<number>[] = []
    const entered: SpanContext[] = []
    try {
      const source = atom(1, 'links.async.source')
      const consumer = computed(() => {
        const index = pending.length
        const value = source()
        entered.push(otel.getCurrentContext()!)
        const result = (async () => {
          await wrap(gates[index]!.promise)
          return value
        })()
        pending.push(result)
        return result
      }, 'links.async.consumer')
      expect(run(consumer)).toBe(pending[0])
      expect(run(() => source.set(2))).toBe(2)
      expect(run(consumer)).toBe(pending[1])
      // This later write must not replace execution #2's synchronous snapshot.
      expect(run(() => source.set(3))).toBe(3)
      for (const index of reverse ? [1, 0] : [0, 1]) {
        gates[index]!.resolve()
        expect(await pending[index]).toBe(index + 1)
      }
      await otel.flush()
      const writes = spans.filter((span) => span.name === 'links.async.source')
      expect(writes).toHaveLength(2)
      const consumers = entered.map(
        (ctx) => spans.find((span) => span.spanId === ctx.spanId)!,
      )
      expect(consumers.every(Boolean)).toBe(true)
      expect(consumers[0]!.links ?? []).toEqual([])
      expect(consumers[1]!.links).toEqual([pair(writes[0]!)])
      expect(consumers[1]!.parentSpanId).toBeUndefined()
      expect(pending).toHaveLength(2)
      expect(run(source)).toBe(3)
    } finally {
      gates.forEach((gate) => gate.resolve())
      await Promise.allSettled(pending)
      otel.dispose()
    }
  },
)

test('two adapters keep independent cause pairs after one is disposed', async () => {
  const first = setup(),
    second = setup()
  try {
    const source = atom(1, 'links.shared.source')
    const consumer = computed(() => source() * 2, 'links.shared.consumer')
    expect(first.run(consumer)).toBe(2)
    expect(first.run(() => source.set(2))).toBe(2)
    expect(first.run(consumer)).toBe(4)
    await Promise.all([first.otel.flush(), second.otel.flush()])
    for (const current of [first, second]) {
      const write = current.spans.find(
        (span) => span.name === 'links.shared.source',
      )!
      const consumers = current.spans.filter(
        (span) => span.name === 'links.shared.consumer',
      )
      expect(consumers).toHaveLength(2)
      expect(write).toBeDefined()
      expect(consumers[1]!.links).toEqual([pair(write)])
    }
    const firstWrite = first.spans.find(
      (span) => span.name === 'links.shared.source',
    )!
    const secondWrite = second.spans.find(
      (span) => span.name === 'links.shared.source',
    )!
    expect(firstWrite.spanId).not.toBe(secondWrite.spanId)
    const firstCount = first.spans.length
    first.otel.dispose()
    expect(first.run(() => source.set(3))).toBe(3)
    expect(first.run(consumer)).toBe(6)
    await second.otel.flush()
    const writes = second.spans.filter(
      (span) => span.name === 'links.shared.source',
    )
    const consumers = second.spans.filter(
      (span) => span.name === 'links.shared.consumer',
    )
    expect(writes).toHaveLength(2)
    expect(consumers).toHaveLength(3)
    expect(consumers[2]!.links).toEqual([pair(writes[1]!)])
    expect(first.spans).toHaveLength(firstCount)
  } finally {
    first.otel.dispose()
    second.otel.dispose()
  }
})

test('bidirectional computation keeps application results and excludes later executions', async () => {
  const results: number[][] = []
  for (const traced of [false, true]) {
    const instance = traced ? setup() : undefined
    const run: <T>(callback: () => T) => T =
      instance?.run ??
      context.start(() => bind(<T>(callback: () => T) => callback()))
    const starts: SpanContext[] = []
    const entered = () => {
      const current = instance?.otel.getCurrentContext()
      if (current) starts.push(current)
    }
    try {
      const left: Atom<number> = atom(0, 'links.cycle.left').extend(
        withComputed(() => {
          entered()
          return right() / 2
        }),
      )
      const right: Atom<number> = atom(0, 'links.cycle.right').extend(
        withComputed(() => {
          entered()
          return left() * 2
        }),
      )
      const values = run(() => {
        const values = [left(), right()]
        left.set(() => {
          entered()
          return 3
        })
        values.push(left(), right())
        right.set(() => {
          entered()
          return 10
        })
        values.push(left(), right())
        return values
      })
      results.push(values)
      expect(values).toEqual([0, 0, 3, 6, 5, 10])
      if (instance) {
        await instance.otel.flush()
        const order = (ctx: SpanContext) =>
          starts.findIndex(
            (entry) =>
              entry.traceId === ctx.traceId && entry.spanId === ctx.spanId,
          )
        expect(instance.spans).toHaveLength(starts.length)
        expect(starts.length).toBeGreaterThan(2)
        for (const span of instance.spans) {
          expect(order(span)).toBeGreaterThanOrEqual(0)
          for (const cause of span.links ?? []) {
            expect(order(cause)).toBeGreaterThanOrEqual(0)
            expect(order(cause)).toBeLessThan(order(span))
          }
        }
      }
    } finally {
      instance?.otel.dispose()
    }
  }
  expect(results[1]).toEqual(results[0])
})
