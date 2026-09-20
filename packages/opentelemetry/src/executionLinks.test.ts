import { action, atom, bind, computed, context, notify } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

type Link = { traceId: string; spanId: string }
type WireSpan = Link & {
  name: string
  parentSpanId?: string
  links?: Link[]
}

type WirePayload = {
  resourceSpans?: Array<{
    scopeSpans?: Array<{ spans?: WireSpan[] }>
  }>
}

const linksOf = (span: WireSpan): Link[] => span.links ?? []
const linkOf = (span: WireSpan): Link => ({
  traceId: span.traceId,
  spanId: span.spanId,
})
const named = (spans: readonly WireSpan[], name: string) =>
  spans.filter((span) => span.name === name)

const setup = () => {
  const bodies: string[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'execution-links-test',
    maxBatchSize: 100,
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response('{}', { status: 200 })
    },
  })
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  const wire = () =>
    bodies.flatMap((body) => {
      const payload = JSON.parse(body) as WirePayload
      return (payload.resourceSpans ?? []).flatMap((resource) =>
        (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
      )
    })
  const exported = () => {
    const raw = wire()
    // Keep parseSpans in the fixture for the normal decoded projection, while
    // links stay raw until the shared decoder owns that field.
    expect(bodies.flatMap(parseSpans).map((span) => span.name)).toEqual(
      raw.map((span) => span.name),
    )
    return raw
  }
  return { otel, run, exported }
}

test('links both independent writes into one repeated computed execution', async () => {
  const { otel, run, exported } = setup()
  let detach = () => {}
  try {
    const a = atom(1, 'links.multi.a')
    const b = atom(10, 'links.multi.b')
    let calls = 0
    const sum = computed(() => {
      calls++
      return a() + b()
    }, 'links.multi.sum')
    const notifications: number[] = []
    detach = run(() => sum.subscribe((value) => notifications.push(value)))

    const write = action(() => {
      a.set(2)
      b.set(20)
      return 22
    }, 'links.multi.write')
    expect(run(write)).toBe(22)
    run(notify)
    expect(run(sum)).toBe(22)
    expect(calls).toBe(2)
    expect(notifications).toEqual([11, 22])

    await otel.flush()
    const spans = exported()
    const sums = named(spans, 'links.multi.sum')
    const aWrites = named(spans, 'links.multi.a')
    const bWrites = named(spans, 'links.multi.b')
    expect(sums).toHaveLength(2)
    expect(aWrites).toHaveLength(1)
    expect(bWrites).toHaveLength(1)
    expect(linksOf(sums[0]!)).toEqual([])
    expect(linksOf(sums[1]!)).toEqual([
      linkOf(aWrites[0]!),
      linkOf(bWrites[0]!),
    ])
    expect(spans.indexOf(aWrites[0]!)).toBeLessThan(spans.indexOf(sums[1]!))
    expect(spans.indexOf(bWrites[0]!)).toBeLessThan(spans.indexOf(sums[1]!))
  } finally {
    run(detach)
    run(notify)
    otel.dispose()
  }
})

test('links only the selector that changes an established branch', async () => {
  const { otel, run, exported } = setup()
  let detach = () => {}
  try {
    const flag = atom(true, 'links.branch.flag')
    const x = atom(1, 'links.branch.x')
    const y = atom(10, 'links.branch.y')
    let calls = 0
    const selected = computed(() => {
      calls++
      return flag() ? x() : y()
    }, 'links.branch.selected')
    const notifications: number[] = []
    detach = run(() => selected.subscribe((value) => notifications.push(value)))

    run(() => {
      x.set(2)
      notify()
    })
    run(() => y.set(20))
    run(() => flag.set(false))
    run(notify)
    expect(run(selected)).toBe(20)
    expect(calls).toBe(3)
    expect(notifications).toEqual([1, 2, 20])

    await otel.flush()
    const spans = exported()
    const selectedSpans = named(spans, 'links.branch.selected')
    const flagWrites = named(spans, 'links.branch.flag')
    const xSpans = named(spans, 'links.branch.x')
    const yWrites = named(spans, 'links.branch.y')
    expect(selectedSpans).toHaveLength(3)
    expect(flagWrites).toHaveLength(1)
    expect(xSpans).toHaveLength(1)
    expect(yWrites).toHaveLength(1)
    expect(linksOf(selectedSpans[0]!)).toEqual([])
    expect(linksOf(selectedSpans[2]!)).toEqual([linkOf(flagWrites[0]!)])
    expect(linksOf(selectedSpans[2]!)).not.toContainEqual(linkOf(xSpans[0]!))
    expect(linksOf(selectedSpans[2]!)).not.toContainEqual(linkOf(yWrites[0]!))
  } finally {
    run(detach)
    run(notify)
    otel.dispose()
  }
})

test('excludes an equal recompute and its source while linking the trigger', async () => {
  const { otel, run, exported } = setup()
  let detach = () => {}
  try {
    const source = atom(0, 'links.equal.source')
    const trigger = atom(0, 'links.equal.trigger')
    let parityCalls = 0
    const parity = computed(() => {
      parityCalls++
      return source() % 2
    }, 'links.equal.parity')
    let consumerCalls = 0
    const consumer = computed(() => {
      consumerCalls++
      return parity() + trigger()
    }, 'links.equal.consumer')
    const notifications: number[] = []
    detach = run(() => consumer.subscribe((value) => notifications.push(value)))

    const write = action(() => {
      source.set(2)
      trigger.set(1)
      return 1
    }, 'links.equal.write')
    expect(run(write)).toBe(1)
    run(notify)
    expect(run(() => [source(), parity(), trigger(), consumer()])).toEqual([
      2, 0, 1, 1,
    ])
    expect(parityCalls).toBe(2)
    expect(consumerCalls).toBe(2)
    expect(notifications).toEqual([0, 1])

    await otel.flush()
    const spans = exported()
    const consumers = named(spans, 'links.equal.consumer')
    const paritySpans = named(spans, 'links.equal.parity')
    const sourceWrites = named(spans, 'links.equal.source')
    const triggerWrites = named(spans, 'links.equal.trigger')
    expect(consumers).toHaveLength(2)
    expect(paritySpans).toHaveLength(2)
    expect(sourceWrites).toHaveLength(1)
    expect(triggerWrites).toHaveLength(1)
    expect(linksOf(consumers[1]!)).toEqual([linkOf(triggerWrites[0]!)])
    expect(linksOf(consumers[1]!)).not.toContainEqual(linkOf(paritySpans[1]!))
    expect(linksOf(consumers[1]!)).not.toContainEqual(linkOf(sourceWrites[0]!))
  } finally {
    run(detach)
    run(notify)
    otel.dispose()
  }
})

test('diamond links the preceding branch and source, never its current descendant or itself', async () => {
  const { otel, run, exported } = setup()
  let detach = () => {}
  try {
    const a = atom(1, 'links.diamond.a')
    let leftCalls = 0
    const left = computed(() => {
      leftCalls++
      return a() + 10
    }, 'links.diamond.left')
    let rightCalls = 0
    const right = computed(() => {
      rightCalls++
      return a() * 2
    }, 'links.diamond.right')
    let sumCalls = 0
    const sum = computed(() => {
      sumCalls++
      return left() + right()
    }, 'links.diamond.sum')
    const notifications: number[] = []
    detach = run(() => sum.subscribe((value) => notifications.push(value)))

    const write = action(() => a.set(2), 'links.diamond.write')
    expect(run(write)).toBe(2)
    run(notify)
    expect(run(() => [a(), left(), right(), sum()])).toEqual([2, 12, 4, 16])
    expect([leftCalls, rightCalls, sumCalls]).toEqual([2, 2, 2])
    expect(notifications).toEqual([13, 16])

    await otel.flush()
    const spans = exported()
    const sums = named(spans, 'links.diamond.sum')
    const leftSpans = named(spans, 'links.diamond.left')
    const rightSpans = named(spans, 'links.diamond.right')
    const aWrites = named(spans, 'links.diamond.a')
    expect(sums).toHaveLength(2)
    expect(leftSpans).toHaveLength(2)
    expect(rightSpans).toHaveLength(2)
    expect(aWrites).toHaveLength(1)
    expect(linksOf(sums[0]!)).toEqual([])
    expect(linksOf(sums[1]!)).toEqual([
      linkOf(leftSpans[1]!),
      linkOf(aWrites[0]!),
    ])
    expect(spans.indexOf(leftSpans[1]!)).toBeLessThan(spans.indexOf(sums[1]!))
    expect(rightSpans[1]!.parentSpanId).toBe(sums[1]!.spanId)
    expect(linksOf(sums[1]!)).not.toContainEqual(linkOf(rightSpans[1]!))
    expect(linksOf(sums[1]!)).not.toContainEqual(linkOf(sums[1]!))
  } finally {
    run(detach)
    run(notify)
    otel.dispose()
  }
})

test('old lazy copy links the older source pair without changing its new parent', async () => {
  const { otel, run, exported } = setup()
  try {
    const source = atom(1, 'links.oldlazy.source')
    let dependencyCalls = 0
    const dependency = computed(() => {
      dependencyCalls++
      return source() * 10
    }, 'links.oldlazy.dependency')
    let consumerCalls = 0
    const consumer = computed(() => {
      consumerCalls++
      return dependency() + 1
    }, 'links.oldlazy.consumer')

    expect(run(consumer)).toBe(11)
    expect(
      run(() => otel.startTrace('links.oldlazy.old-root', () => source.set(2))),
    ).toBe(2)
    expect(
      run(() => otel.startTrace('links.oldlazy.new-root', () => consumer())),
    ).toBe(21)
    expect([dependencyCalls, consumerCalls]).toEqual([2, 2])

    await otel.flush()
    const spans = exported()
    const sources = named(spans, 'links.oldlazy.source')
    const consumers = named(spans, 'links.oldlazy.consumer')
    const oldRoots = named(spans, 'links.oldlazy.old-root')
    const newRoots = named(spans, 'links.oldlazy.new-root')
    expect(sources).toHaveLength(1)
    expect(consumers).toHaveLength(2)
    expect(oldRoots).toHaveLength(1)
    expect(newRoots).toHaveLength(1)
    const sourceWrite = sources[0]!
    const copiedConsumer = consumers[1]!
    expect(sourceWrite.traceId).toBe(oldRoots[0]!.traceId)
    expect(copiedConsumer.traceId).toBe(newRoots[0]!.traceId)
    expect(copiedConsumer.traceId).not.toBe(sourceWrite.traceId)
    expect(copiedConsumer.parentSpanId).toBe(newRoots[0]!.spanId)
    expect(linksOf(copiedConsumer)).toEqual([linkOf(sourceWrite)])
  } finally {
    otel.dispose()
  }
})

test('same targets in two stores only link each store to its own source pair', async () => {
  const { otel, run, exported } = setup()
  const runSecond = context.start(() =>
    bind(<T>(callback: () => T) => callback()),
  )
  let detachFirst = () => {}
  let detachSecond = () => {}
  try {
    const source = atom(1, 'links.stores.source')
    let calls = 0
    const doubled = computed(() => {
      calls++
      return source() * 2
    }, 'links.stores.doubled')
    const firstNotifications: number[] = []
    const secondNotifications: number[] = []
    detachFirst = run(() =>
      doubled.subscribe((value) => firstNotifications.push(value)),
    )
    detachSecond = runSecond(() =>
      doubled.subscribe((value) => secondNotifications.push(value)),
    )
    const writeFirst = action(() => source.set(3), 'links.stores.write.first')
    const writeSecond = action(() => source.set(4), 'links.stores.write.second')

    expect(run(writeFirst)).toBe(3)
    run(notify)
    expect(runSecond(writeSecond)).toBe(4)
    runSecond(notify)
    expect(run(doubled)).toBe(6)
    expect(runSecond(doubled)).toBe(8)
    expect(calls).toBe(4)
    expect(firstNotifications).toEqual([2, 6])
    expect(secondNotifications).toEqual([2, 8])

    await otel.flush()
    const spans = exported()
    const sourceSpans = named(spans, 'links.stores.source')
    const doubledSpans = named(spans, 'links.stores.doubled')
    const firstWrites = named(spans, 'links.stores.write.first')
    const secondWrites = named(spans, 'links.stores.write.second')
    expect(sourceSpans).toHaveLength(2)
    expect(doubledSpans).toHaveLength(4)
    expect(firstWrites).toHaveLength(1)
    expect(secondWrites).toHaveLength(1)
    const firstSource = sourceSpans.find(
      (span) => span.parentSpanId === firstWrites[0]!.spanId,
    )
    const secondSource = sourceSpans.find(
      (span) => span.parentSpanId === secondWrites[0]!.spanId,
    )
    expect(firstSource).toBeDefined()
    expect(secondSource).toBeDefined()
    expect(linksOf(doubledSpans[2]!)).toEqual([linkOf(firstSource!)])
    expect(linksOf(doubledSpans[3]!)).toEqual([linkOf(secondSource!)])
    expect(linksOf(doubledSpans[2]!)).not.toContainEqual(linkOf(secondSource!))
    expect(linksOf(doubledSpans[3]!)).not.toContainEqual(linkOf(firstSource!))
  } finally {
    run(detachFirst)
    runSecond(detachSecond)
    run(notify)
    runSecond(notify)
    otel.dispose()
  }
})
