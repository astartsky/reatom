import type { AtomLike, Frame } from '@reatom/core'
import { expect, test } from 'vitest'

import { createLinkCollector } from './collectLinks.ts'
import type { SpanId } from './generateSpanId.ts'
import type { TraceId } from './generateTraceId.ts'

// Plain graph records isolate traversal/ownership. executionLinks.test.ts
// supplies the independent real-runtime and wire controls.
const root = {} as Frame['root']
const target = () => (() => {}) as AtomLike
const frame = (state: unknown, atom = target(), pubs: Frame[] = []): Frame =>
  ({ atom, root, state, error: null, pubs: [null, ...pubs] }) as Frame
const context = (n: number, trace = 1) => ({
  traceId: trace.toString(16).padStart(32, '0') as TraceId,
  spanId: n.toString(16).padStart(16, '0') as SpanId,
})
const remember = (
  collector: ReturnType<typeof createLinkCollector>,
  value: Frame,
  n: number,
  trace = 1,
) => {
  const execution = collector.start(value)
  execution.context = context(n, trace)
  collector.finish(value, [null], execution)
  return execution
}
const collect = (
  collector: ReturnType<typeof createLinkCollector>,
  previous: Frame[],
  current: Frame[],
) => {
  const consumer = frame(0, target(), current)
  const execution = collector.start(consumer)
  execution.context = context(1000)
  collector.finish(consumer, [null, ...previous], execution)
  return execution.links ?? []
}

test('changed common inputs produce owned complete pairs, deduplicated by both IDs', () => {
  const collector = createLinkCollector()
  const a = frame(1),
    b = frame(1)
  const nextA = frame(2, a.atom),
    nextB = frame(2, b.atom)
  const first = remember(collector, nextA, 7, 1)
  const firstPair = { ...first.context! }
  first.context = firstPair
  remember(collector, nextB, 7, 2)
  const links = collect(collector, [a, b], [nextA, nextB, nextA])
  expect(links).toEqual([context(7, 1), context(7, 2)])
  expect(links[0]).not.toBe(firstPair)
  firstPair.spanId = context(9).spanId
  expect(links).toEqual([context(7, 1), context(7, 2)])
})

test('equal state and error prune the complete subgraph, even after a real execution', () => {
  const collector = createLinkCollector()
  const source = frame(1),
    changed = frame(2, source.atom)
  remember(collector, changed, 1)
  const old = frame(0, target(), [source]),
    fresh = frame(0, old.atom, [changed])
  remember(collector, fresh, 2)
  expect(collect(collector, [old], [fresh])).toEqual([])
})

test('changed errors are inputs even when state is identical', () => {
  const collector = createLinkCollector()
  const old = frame(0),
    fresh = frame(0, old.atom)
  fresh.error = new Error('failed')
  remember(collector, fresh, 1)
  expect(collect(collector, [old], [fresh])).toEqual([context(1)])
  const recovered = frame(0, old.atom)
  remember(collector, recovered, 2)
  expect(collect(collector, [fresh], [recovered])).toEqual([context(2)])
})

test('missing copy context walks paired changed dependencies, never target history', () => {
  const collector = createLinkCollector()
  const source = frame(1),
    changed = frame(2, source.atom)
  remember(collector, changed, 1)
  const old = frame(10, target(), [source])
  const computed = frame(20, old.atom, [changed])
  remember(collector, computed, 2)
  const copy = frame(20, old.atom, [changed])
  expect(collect(collector, [old], [copy])).toEqual([context(1)])
})

test('nearest eligible context stops a changed branch', () => {
  const collector = createLinkCollector()
  const source = frame(1),
    changed = frame(2, source.atom)
  remember(collector, changed, 1)
  const old = frame(10, target(), [source]),
    fresh = frame(20, old.atom, [changed])
  remember(collector, fresh, 2)
  expect(collect(collector, [old], [fresh])).toEqual([context(2)])
})

test('first execution, added/removed inputs, foreign roots and ambiguous versions are omitted', () => {
  const collector = createLinkCollector()
  const old = frame(1),
    fresh = frame(2, old.atom),
    added = frame(3)
  remember(collector, fresh, 1)
  remember(collector, added, 2)
  expect(collect(collector, [], [fresh])).toEqual([])
  expect(collect(collector, [old], [added])).toEqual([])
  const foreign = { ...fresh, root: {} as Frame['root'] }
  remember(collector, foreign, 3)
  expect(collect(collector, [old], [foreign])).toEqual([])
  expect(collect(collector, [old], [fresh, frame(4, old.atom)])).toEqual([])
})

test('active and descendant executions are not causes; their changed inputs may be', () => {
  const collector = createLinkCollector()
  const source = frame(1),
    changed = frame(2, source.atom)
  remember(collector, changed, 1)
  const old = frame(10, target(), [source]),
    fresh = frame(20, old.atom, [changed])
  const consumer = frame(0, target(), [fresh])
  const execution = collector.start(consumer)
  execution.context = context(9)
  remember(collector, fresh, 2)
  collector.finish(consumer, [null, old], execution)
  expect(execution.links).toEqual([context(1)])

  const active = collector.start(fresh)
  active.context = context(3)
  expect(collect(collector, [old], [fresh])).toEqual([context(1)])
})

test('rejected same-frame execution invalidates its prior span', () => {
  const collector = createLinkCollector()
  const old = frame(1),
    fresh = frame(2, old.atom)
  remember(collector, fresh, 1)
  const rejected = collector.start(fresh)
  collector.finish(fresh, [null], rejected)
  expect(collect(collector, [old], [fresh])).toEqual([])
})

test('out-of-order completion cannot leave an inner span attached to an outer result', () => {
  const collector = createLinkCollector()
  const old = frame(1),
    fresh = frame(2, old.atom)
  const outer = collector.start(fresh)
  outer.context = context(1)
  remember(collector, fresh, 2)
  collector.finish(fresh, [null], outer)
  expect(collect(collector, [old], [fresh])).toEqual([])
})

test('cyclic graphs terminate and do not link self', () => {
  const collector = createLinkCollector()
  const old = frame(1),
    fresh = frame(2, old.atom)
  old.pubs.push(old)
  fresh.pubs.push(fresh)
  const execution = collector.start(fresh)
  execution.context = context(1)
  collector.finish(fresh, old.pubs, execution)
  expect(execution.links ?? []).toEqual([])
})

test('at most 32 pairs are retained', () => {
  const collector = createLinkCollector()
  const before = Array.from({ length: 40 }, () => frame(1))
  const after = before.map((old, index) => {
    const fresh = frame(2, old.atom)
    remember(collector, fresh, index + 1)
    return fresh
  })
  expect(collect(collector, before, after)).toEqual(
    Array.from({ length: 32 }, (_, i) => context(i + 1)),
  )
})

test('the traversal budget is shared by every level of a deep graph', () => {
  const collector = createLinkCollector()
  const oldest = frame(1)
  const newest = frame(2, oldest.atom)
  remember(collector, newest, 1)
  let before = oldest,
    after = newest
  let reads = 0
  for (let i = 0; i < 200; i++) {
    const old = frame(1, target(), [before])
    const fresh = frame(2, old.atom, [after])
    for (const node of [old, fresh]) {
      node.pubs = new Proxy(node.pubs, {
        get(array, key, receiver) {
          if (key === '1') reads++
          return Reflect.get(array, key, receiver)
        },
      })
    }
    before = old
    after = fresh
  }
  expect(collect(collector, [before], [after])).toEqual([])
  expect(reads).toBeGreaterThan(0)
  expect(reads).toBeLessThanOrEqual(256)
})

test('oversized duplicate arrays are rejected before scanning beyond the budget', () => {
  const collector = createLinkCollector()
  const old = frame(1),
    fresh = frame(2, old.atom)
  remember(collector, fresh, 1)
  const consumer = frame(0)
  const execution = collector.start(consumer)
  execution.context = context(9)
  let reads = 0
  const huge = new Proxy([null, ...Array<Frame>(10_000).fill(fresh)], {
    get(target, key, receiver) {
      if (/^\d+$/.test(String(key))) reads++
      return Reflect.get(target, key, receiver)
    },
  }) as Frame['pubs']
  consumer.pubs = huge
  collector.finish(consumer, [null, old], execution)
  expect(reads).toBeLessThanOrEqual(256)
  expect(execution.links ?? []).toEqual([])
})

test('dispose is terminal for old and newly registered records', () => {
  const collector = createLinkCollector()
  const old = frame(1),
    fresh = frame(2, old.atom)
  remember(collector, fresh, 1)
  collector.dispose()
  remember(collector, fresh, 2)
  expect(collect(collector, [old], [fresh])).toEqual([])
})
