import {
  action,
  atom,
  bind,
  computed,
  context,
  isAbort,
  top,
  variable,
  withAbort,
  wrap,
} from '@reatom/core'
import { expect, test, vi } from 'vitest'

import {
  reatomOpentelemetry,
  type ReatomOpentelemetryInput,
} from './reatomOpentelemetry.ts'
import type { SpanContext } from './spanContext.ts'
import { type ParsedSpan, parseSpans } from './test-helpers.ts'

const setup = (options: Partial<ReatomOpentelemetryInput> = {}) => {
  const spans: ParsedSpan[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'context-test',
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      spans.push(...parseSpans(String(init?.body)))
      return new Response(null)
    },
    ...options,
  })
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  return { otel, spans, run }
}

// Exact names and every parent pair: zero emission and all-root graphs fail.
const expectTree = (
  spans: ParsedSpan[],
  parents: Record<string, string | null>,
) => {
  expect(spans.map((s) => s.name).sort()).toEqual(Object.keys(parents).sort())
  const byName = new Map(spans.map((s) => [s.name, s]))
  for (const [name, parentName] of Object.entries(parents)) {
    const span = byName.get(name)!
    if (parentName === null) expect(span.parentSpanId).toBeUndefined()
    else {
      const parent = byName.get(parentName)!
      expect(span.parentSpanId).toBe(parent.spanId)
      expect(span.traceId).toBe(parent.traceId)
    }
  }
  const roots = Object.keys(parents).filter((name) => parents[name] === null)
  expect(new Set(roots.map((name) => byName.get(name)!.traceId)).size).toBe(
    roots.length,
  )
}

test('a pending wrapped Promise retains store and variables after final disposal', async () => {
  const value = atom(0)
  const scope = variable<string>()
  const { otel } = setup({ filter: () => false })
  const gate = Promise.withResolvers<void>()
  let pending: Promise<number> | undefined
  let resumed: unknown[] = []
  try {
    pending = context.start(() => {
      value.set(7)
      return scope.run('kept', () =>
        otel.startTrace('pending', async () => {
          const frame = top()
          await wrap(gate.promise)
          resumed = [top() === frame, scope.get(), otel.getCurrentContext()]
          return value()
        }),
      )
    })
    otel.dispose()
    gate.resolve()
    expect(await pending).toBe(7)
    expect(resumed).toEqual([true, 'kept', undefined])
    expect(context.start(value)).toBe(0)
  } finally {
    gate.resolve()
    await pending
    otel.dispose()
  }
})

test.each([false, true])(
  'final disposal preserves pending cancellation (abort=%s)',
  async (abort: boolean) => {
    const { otel, run } = setup({ filter: () => false })
    const gate = Promise.withResolvers<void>()
    let calls = 0
    let inner: Promise<number>
    const target = action(() => {
      return (inner = (async () => {
        await wrap(gate.promise)
        calls++
        return 7
      })())
    }).extend(withAbort('manual'))
    const pending = run(target).then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    const innerSettled = inner!.then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    try {
      otel.dispose()
      if (abort) run(() => target.abort('stop'))
      gate.resolve()
      const result = await pending
      const innerResult = await innerSettled
      if (abort) {
        expect('error' in result && isAbort(result.error)).toBe(true)
        expect(innerResult).toEqual(result)
        expect(calls).toBe(0)
      } else {
        expect(result).toEqual({ value: 7 })
        expect(innerResult).toEqual({ value: 7 })
        expect(calls).toBe(1)
      }
    } finally {
      gate.resolve()
      await Promise.all([pending, innerSettled])
      otel.dispose()
    }
  },
)

test('nested async roots reenter both adapters explicitly on the preserved store frame', async () => {
  const a = setup()
  const b = setup()
  const gate = Promise.withResolvers<void>()
  let promise: Promise<number> | undefined
  let entered: Array<SpanContext | undefined> = []
  let resumed: Array<SpanContext | undefined> = []
  const frames: boolean[] = []
  const frame = a.run(top)
  try {
    const child = action(() => 42, 'child')
    const result = a.run(() =>
      a.otel.startTrace('a', () =>
        b.otel.startTrace('b', () => {
          frames.push(top() === frame)
          const contextA = a.otel.getCurrentContext()
          const contextB = b.otel.getCurrentContext()
          entered = [contextA, contextB]
          return (promise = (async () => {
            await wrap(gate.promise)
            frames.push(top() === frame)
            return a.otel.withContext(contextA, () =>
              b.otel.withContext(contextB, () => {
                resumed = [
                  a.otel.getCurrentContext(),
                  b.otel.getCurrentContext(),
                ]
                return child()
              }),
            )
          })())
        }),
      ),
    )
    expect(result).toBe(promise)
    expect(a.otel.getCurrentContext()).toBeUndefined()
    expect(b.otel.getCurrentContext()).toBeUndefined()
    gate.resolve()
    expect(await result).toBe(42)
    expect(frames).toEqual([true, true])
    expect(entered.every((pair) => pair !== undefined)).toBe(true)
    expect(resumed).toEqual(entered)
    await a.otel.flush()
    await b.otel.flush()
    expectTree(a.spans, { a: null, child: 'a' })
    expectTree(b.spans, { b: null, child: 'b' })
    expect(a.otel.getCurrentContext()).toBeUndefined()
    expect(b.otel.getCurrentContext()).toBeUndefined()
  } finally {
    gate.resolve()
    await promise?.catch(() => {})
    a.otel.dispose()
    b.otel.dispose()
  }
})

test('explicit roots separate outer trace, group siblings, restore context and preserve returns', async () => {
  const { otel, spans, run } = setup()
  const result = { result: 1 }
  const seen: SpanContext[] = []
  const restored: boolean[] = []
  let returned: unknown
  try {
    const a = action(() => 'a', 'a')
    const b = action(() => 'b', 'b')
    const c = action(() => 'c', 'c')
    const after = action(() => 'after', 'after')
    const outer = action(() => {
      const previous = otel.getCurrentContext()!
      returned = otel.startTrace('first', () => {
        seen.push(otel.getCurrentContext()!)
        a()
        b()
        return result
      })
      restored.push(otel.getCurrentContext() === previous)
      otel.startTrace('second', () => {
        c()
      })
      restored.push(otel.getCurrentContext() === previous)
      after()
    }, 'outer')
    run(outer)
    expect(returned).toBe(result)
    expect(restored).toEqual([true, true])
    expect(run(otel.getCurrentContext)).toBeUndefined()
    expect(Object.isFrozen(seen[0])).toBe(true)
    await otel.flush()
    expectTree(spans, {
      outer: null,
      first: null,
      second: null,
      a: 'first',
      b: 'first',
      c: 'second',
      after: 'outer',
    })
    expect(seen[0]).toEqual(
      expect.objectContaining({
        traceId: spans.find((s) => s.name === 'first')!.traceId,
        spanId: spans.find((s) => s.name === 'first')!.spanId,
      }),
    )
  } finally {
    otel.dispose()
  }
})

test('explicit context crosses filtered actions, computed and lazy initialization', async () => {
  const { otel, spans, run } = setup({
    filter: (target) => !target.name.startsWith('filtered'),
  })
  try {
    const leaf = action(() => 'value', 'leaf')
    const lazy = atom(() => leaf(), 'filteredLazy')
    const derived = computed(() => lazy(), 'filteredComputed')
    const sync = action(() => derived(), 'filteredSync')
    const asyncCarrier = action(async () => {
      const saved = otel.getCurrentContext()
      await wrap(Promise.resolve())
      return otel.withContext(saved, sync)
    }, 'filteredAsync')
    const parent = action(() => asyncCarrier(), 'parent')
    expect(await run(parent)).toBe('value')
    await otel.flush()
    expectTree(spans, { parent: null, leaf: 'parent' })
    expect(otel.stats().dropped).toBe(0)
  } finally {
    otel.dispose()
  }
})

test.each([false, true])(
  'startTrace uses current store and inherits cancellation (abort=%s)',
  async (abort: boolean) => {
    const state = atom(0, 'state')
    const user = variable<string>('traceTestUser')
    const gate = Promise.withResolvers<void>()
    const { otel, spans, run } = setup({
      filter: (target) => target.name === 'downstream',
    })
    let writes = 0
    let entered: unknown[] = []
    let settled: Promise<{ value: number } | { error: unknown }> | undefined
    try {
      const downstream = action(() => {
        writes++
        return state()
      }, 'downstream')
      const outer = action(
        () =>
          otel.startTrace('trace', async () => {
            entered = [state(), user.get()]
            const saved = otel.getCurrentContext()
            state.set(8)
            await wrap(gate.promise)
            return otel.withContext(saved, downstream)
          }),
        'outer',
      ).extend(withAbort('manual'))
      const result = run(() => {
        state.set(7)
        return user.run('current-user', () => outer())
      })
      // Attach a rejection handler before abort so the test does not leak it.
      settled = result.then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
      expect(entered).toEqual([7, 'current-user'])
      expect(run(state)).toBe(8)
      if (abort) run(() => outer.abort('stop'))
      gate.resolve()
      const outcome = await settled
      if (abort) {
        expect('error' in outcome && isAbort(outcome.error)).toBe(true)
        expect(writes).toBe(0)
      } else {
        expect(outcome).toEqual({ value: 8 })
        expect(writes).toBe(1)
      }
      await otel.flush()
      expectTree(
        spans,
        abort ? { trace: null } : { trace: null, downstream: 'trace' },
      )
    } finally {
      gate.resolve()
      await settled
      otel.dispose()
    }
  },
)

test.each([false, true])(
  'rejected invocation preserves ordinary parent or explicit boundary (explicit=%s)',
  async (explicit: boolean) => {
    const { otel, spans, run } = setup({
      maxQueueSize: 4,
      maxBatchSize: 10,
      filter: (target) => target.name !== 'carrier',
    })
    const gate = Promise.withResolvers<void>()
    const ids = vi.spyOn(crypto, 'getRandomValues')
    let parentContext: SpanContext | undefined
    let entered: SpanContext | undefined
    let resumed: SpanContext | undefined
    let beforeRejection: unknown
    let restored: SpanContext | undefined
    let allocatedOnRejection = -1
    let pending: Promise<void> | undefined
    try {
      const fill1 = action(() => 1, 'fill1'),
        fill2 = action(() => 2, 'fill2'),
        fill3 = action(() => 3, 'fill3')
      const grandchild = action(() => 1, 'grandchild')
      const child = action(() => grandchild(), 'child')
      const sibling = action(() => 2, 'sibling')
      const carrier = action(async () => {
        const saved = (entered = otel.getCurrentContext())
        await wrap(gate.promise)
        otel.withContext(saved, () => {
          resumed = otel.getCurrentContext()
          child()
          sibling()
        })
      }, 'carrier')
      const rejected = action(() => carrier(), 'rejected')
      const outer = action(() => {
        parentContext = otel.getCurrentContext()
        fill1()
        fill2()
        fill3()
        beforeRejection = otel.stats()
        const before = ids.mock.calls.length
        const promise = explicit
          ? otel.startTrace('rejected', () => carrier())
          : rejected()
        allocatedOnRejection = ids.mock.calls.length - before
        restored = otel.getCurrentContext()
        return promise
      }, 'outer')
      pending = run(outer)
      expect(parentContext).toBeDefined()
      expect(entered).toBe(explicit ? undefined : parentContext)
      expect(restored).toBe(parentContext)
      expect(beforeRejection).toMatchObject({ active: 1, queued: 3 })
      expect(allocatedOnRejection).toBe(0)
      expect(otel.stats()).toMatchObject({
        active: 1,
        queued: 3,
        droppedByReason: { capacity: 1 },
      })
      await otel.flush()
      expect(otel.stats()).toMatchObject({ active: 1, queued: 0, inFlight: 0 })
      gate.resolve()
      await pending
      expect(resumed).toEqual(explicit ? undefined : parentContext)
      await otel.flush()
      expectTree(spans, {
        outer: null,
        fill1: 'outer',
        fill2: 'outer',
        fill3: 'outer',
        child: explicit ? null : 'outer',
        grandchild: 'child',
        sibling: explicit ? null : 'outer',
      })
      expect(otel.stats()).toMatchObject({
        active: 0,
        queued: 0,
        inFlight: 0,
        exported: 7,
        dropped: 1,
      })
    } finally {
      gate.resolve()
      await pending?.catch(() => {})
      otel.dispose()
      ids.mockRestore()
    }
  },
)

test('two adapters keep independent contexts and disposal without instrumenting adapter helpers', async () => {
  const filterA = vi.fn(() => true),
    filterB = vi.fn(() => true)
  const first = setup({ filter: filterA })
  const second = setup({ filter: filterB })
  try {
    expect(filterA.mock.calls).toHaveLength(0)
    expect(filterB.mock.calls).toHaveLength(0)
    const observed: Array<[SpanContext | undefined, SpanContext | undefined]> =
      []
    const child = action(() => {
      observed.push([
        first.otel.getCurrentContext(),
        second.otel.getCurrentContext(),
      ])
    }, 'child')
    const parent = action(() => child(), 'parent')
    first.run(parent)
    await first.otel.flush()
    await second.otel.flush()
    expectTree(first.spans, { parent: null, child: 'parent' })
    expectTree(second.spans, { parent: null, child: 'parent' })
    expect(first.spans[0]!.traceId).not.toBe(second.spans[0]!.traceId)
    expect(observed[0]![0]).toMatchObject({
      spanId: first.spans.find((s) => s.name === 'child')!.spanId,
    })
    expect(observed[0]![1]).toMatchObject({
      spanId: second.spans.find((s) => s.name === 'child')!.spanId,
    })
    first.otel.dispose()
    first.run(parent)
    await first.otel.flush()
    await second.otel.flush()
    expect(first.spans).toHaveLength(2)
    expect(second.spans).toHaveLength(4)
    expect(observed[1]![0]).toBeUndefined()
    expectTree(second.spans.slice(2), { parent: null, child: 'parent' })
  } finally {
    first.otel.dispose()
    second.otel.dispose()
  }
})

test('startTrace preserves thrown identity and becomes a direct passthrough after dispose', async () => {
  const { otel, spans, run } = setup()
  const error = new Error('application')
  try {
    let caught: unknown
    run(() => {
      try {
        otel.startTrace('error', () => {
          throw error
        })
      } catch (err) {
        caught = err
      }
    })
    expect(caught).toBe(error)
    await otel.flush()
    expectTree(spans, { error: null })
    otel.dispose()
    const ids = vi.spyOn(crypto, 'getRandomValues'),
      clock = vi.spyOn(performance, 'now')
    try {
      const promise = Promise.resolve(7)
      expect(otel.startTrace('disposed', () => promise)).toBe(promise)
      expect(otel.getCurrentContext()).toBeUndefined()
      expect(ids).not.toHaveBeenCalled()
      expect(clock).not.toHaveBeenCalled()
    } finally {
      ids.mockRestore()
      clock.mockRestore()
    }
  } finally {
    otel.dispose()
  }
})
