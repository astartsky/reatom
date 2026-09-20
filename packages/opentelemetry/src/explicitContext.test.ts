import { action, atom, bind, context, wrap } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'

interface ParsedSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
}

const createRun = () =>
  context.start(() => bind(<T>(callback: () => T) => callback()))

const setup = (filter: (name: string) => boolean) => {
  const bodies: string[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'no-core-spike',
    retry: { maxRetries: 0 },
    maxBatchSize: 100,
    filter: (target) => filter(target.name),
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response('{}', { status: 200 })
    },
  })
  return { otel, bodies, run: createRun() }
}

const spansOf = (bodies: readonly string[]) =>
  bodies.flatMap((body) => {
    const payload = JSON.parse(body) as {
      resourceSpans?: Array<{
        scopeSpans?: Array<{ spans?: ParsedSpan[] }>
      }>
    }
    return (payload.resourceSpans ?? []).flatMap((resource) =>
      (resource.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    )
  })

const span = (spans: readonly ParsedSpan[], name: string) => {
  const matches = spans.filter((candidate) => candidate.name === name)
  expect(matches).toHaveLength(1)
  return matches[0]!
}

const expectChild = (child: ParsedSpan, parent: ParsedSpan) => {
  expect(child.parentSpanId).toBe(parent.spanId)
  expect(child.traceId).toBe(parent.traceId)
}

test('reverse-overlapping same-action roots require explicit saved-context reentry', async () => {
  const { otel, bodies, run } = setup((name) => name.startsWith('async.'))
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const payloads = [{ index: 0 }, { index: 1 }]
  const saved: Array<ReturnType<typeof otel.getCurrentContext>> = []
  const resumed: Array<ReturnType<typeof otel.getCurrentContext>> = []
  const original: Promise<(typeof payloads)[number]>[] = []
  const bodyCalls: number[] = []
  const childCalls: number[] = []
  let pending: Promise<(typeof payloads)[number]>[] = []
  try {
    const completed = atom<number[]>([], 'async.completed')
    const children = payloads.map((payload) =>
      action(() => {
        childCalls.push(payload.index)
        return payload
      }, `async.child.${payload.index}`),
    )
    const save = action((index: number) => {
      bodyCalls.push(index)
      const result = (async () => {
        saved[index] = otel.getCurrentContext()
        await wrap(gates[index]!.promise)
        return otel.withContext(saved[index], () => {
          resumed[index] = otel.getCurrentContext()
          const payload = children[index]!()
          completed.set([...completed(), index])
          return payload
        })
      })()
      original[index] = result
      return result
    }, 'async.save')

    const first = run(() => otel.startTrace('async.root.0', () => save(0)))
    const second = run(() => otel.startTrace('async.root.1', () => save(1)))
    pending = [first, second]
    expect(first).toBe(original[0])
    expect(second).toBe(original[1])
    expect(saved).toHaveLength(2)
    expect(saved[0]).toBeDefined()
    expect(saved[1]).toBeDefined()
    expect(saved[0]!.spanId).not.toBe(saved[1]!.spanId)
    expect(run(otel.getCurrentContext)).toBeUndefined()

    gates[1]!.resolve()
    expect(await second).toBe(payloads[1])
    gates[0]!.resolve()
    expect(await first).toBe(payloads[0])
    expect(bodyCalls).toEqual([0, 1])
    expect(childCalls).toEqual([1, 0])
    expect(run(completed)).toEqual([1, 0])
    expect(resumed.map((pair) => pair?.spanId)).toEqual(
      saved.map((pair) => pair?.spanId),
    )
    expect(run(otel.getCurrentContext)).toBeUndefined()

    await otel.flush()
    expect(bodies).toHaveLength(1)
    const spans = spansOf(bodies)
    expect(spans.map((item) => item.name).sort()).toEqual([
      'async.child.0',
      'async.child.1',
      'async.root.0',
      'async.root.1',
      'async.save',
      'async.save',
    ])
    for (const index of [0, 1] as const) {
      const root = span(spans, `async.root.${index}`)
      const saveSpan = spans.find(
        (item) =>
          item.name === 'async.save' && item.spanId === saved[index]!.spanId,
      )!
      const child = span(spans, `async.child.${index}`)
      expect(root.parentSpanId).toBeUndefined()
      expectChild(saveSpan, root)
      expectChild(child, saveSpan)
      expect(saved[index]).toMatchObject({
        traceId: saveSpan.traceId,
        spanId: saveSpan.spanId,
      })
    }
  } finally {
    gates.forEach((gate) => gate.resolve())
    await Promise.allSettled(pending)
    otel.dispose()
  }
})

test('an explicit absent context under a root restores the caller and gives its child a fresh root', async () => {
  const { otel, bodies, run } = setup((name) => name.startsWith('absence.'))
  const payload = { value: 'child' }
  try {
    const child = action(() => payload, 'absence.child')
    let caller: ReturnType<typeof otel.getCurrentContext>
    let absent: ReturnType<typeof otel.getCurrentContext>
    let restored: ReturnType<typeof otel.getCurrentContext>
    const result = run(() =>
      otel.startTrace('absence.outer', () => {
        caller = otel.getCurrentContext()
        const childResult = otel.withContext(undefined, () => {
          absent = otel.getCurrentContext()
          return child()
        })
        restored = otel.getCurrentContext()
        return childResult
      }),
    )
    expect(result).toBe(payload)
    expect(caller).toBeDefined()
    expect(absent).toBeUndefined()
    expect(restored).toMatchObject(caller!)
    expect(run(otel.getCurrentContext)).toBeUndefined()

    await otel.flush()
    expect(bodies).toHaveLength(1)
    const spans = spansOf(bodies)
    expect(spans.map((item) => item.name).sort()).toEqual([
      'absence.child',
      'absence.outer',
    ])
    const outer = span(spans, 'absence.outer')
    const childSpan = span(spans, 'absence.child')
    expect(outer.parentSpanId).toBeUndefined()
    expect(childSpan.parentSpanId).toBeUndefined()
    expect(childSpan.traceId).not.toBe(outer.traceId)
  } finally {
    otel.dispose()
  }
})

test('withContext restores after a throw without replacing the application error or result', async () => {
  const { otel, bodies, run } = setup(() => false)
  const error = new Error('async-context-error')
  const expected = { kept: true }
  try {
    let caller: ReturnType<typeof otel.getCurrentContext>
    let absent: ReturnType<typeof otel.getCurrentContext>
    let restored: ReturnType<typeof otel.getCurrentContext>
    let caught: unknown
    const result = run(() =>
      otel.startTrace('throw.root', () => {
        caller = otel.getCurrentContext()
        try {
          otel.withContext(undefined, () => {
            absent = otel.getCurrentContext()
            throw error
          })
        } catch (reason) {
          caught = reason
        }
        restored = otel.getCurrentContext()
        return expected
      }),
    )
    expect(result).toBe(expected)
    expect(caught).toBe(error)
    expect(caller).toBeDefined()
    expect(absent).toBeUndefined()
    expect(restored).toMatchObject(caller!)
    expect(run(otel.getCurrentContext)).toBeUndefined()

    await otel.flush()
    expect(bodies).toHaveLength(1)
    const [root] = spansOf(bodies)
    expect(root!.name).toBe('throw.root')
    expect(root!.parentSpanId).toBeUndefined()
  } finally {
    otel.dispose()
  }
})

test.each(['resolve', 'reject'] as const)(
  'withContext restores before its original Promise settles (%s)',
  async (outcome: 'resolve' | 'reject') => {
    const { otel, bodies, run } = setup((name) => name.startsWith('promise.'))
    const value = { result: 'original' }
    const error = new Error('original rejection')
    const gate = Promise.withResolvers<typeof value>()
    const settled = gate.promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      const saved = run(() =>
        otel.startTrace('promise.saved', otel.getCurrentContext),
      )
      const child = action(() => value, 'promise.child')
      const independent = action(() => value, 'promise.independent')
      const later = action(() => value, 'promise.later')
      let entered: typeof saved
      let childResult: unknown
      const returned = run(() =>
        otel.withContext(saved, () => {
          entered = otel.getCurrentContext()
          childResult = child()
          return gate.promise
        }),
      )
      expect(saved).toBeDefined()
      expect(entered).toEqual(saved)
      expect(childResult).toBe(value)
      expect(returned).toBe(gate.promise)
      expect(otel.getCurrentContext()).toBeUndefined()
      expect(run(independent)).toBe(value)

      if (outcome === 'resolve') gate.resolve(value)
      else gate.reject(error)
      const result = await settled
      if ('value' in result) {
        expect(outcome).toBe('resolve')
        expect(result.value).toBe(value)
      } else {
        expect(outcome).toBe('reject')
        expect(result.error).toBe(error)
      }
      expect(otel.getCurrentContext()).toBeUndefined()
      expect(run(later)).toBe(value)
      await otel.flush()

      const spans = spansOf(bodies)
      expect(spans.map((item) => item.name).sort()).toEqual([
        'promise.child',
        'promise.independent',
        'promise.later',
        'promise.saved',
      ])
      const parent = span(spans, 'promise.saved')
      expectChild(span(spans, 'promise.child'), parent)
      for (const name of ['promise.independent', 'promise.later']) {
        const root = span(spans, name)
        expect(root.parentSpanId).toBeUndefined()
        expect(root.traceId).not.toBe(parent.traceId)
      }
    } finally {
      gate.resolve(value)
      await settled
      otel.dispose()
    }
  },
)

test('withContext owns its pair without freezing or following the caller object', async () => {
  const { otel, bodies, run } = setup((name) => name.startsWith('owned.'))
  const value = { result: 'child' }
  try {
    const saved = run(() =>
      otel.startTrace('owned.saved', otel.getCurrentContext),
    )
    const other = run(() =>
      otel.startTrace('owned.other', otel.getCurrentContext),
    )
    expect(saved).toBeDefined()
    expect(other).toBeDefined()
    expect(saved!.traceId).not.toBe(other!.traceId)
    const input = { ...saved! }
    const child = action(() => value, 'owned.child')
    let current: typeof saved
    const returned = run(() =>
      otel.withContext(input, () => {
        input.traceId = other!.traceId
        input.spanId = other!.spanId
        current = otel.getCurrentContext()
        return child()
      }),
    )
    expect(returned).toBe(value)
    expect(input).toEqual(other)
    expect(Object.isFrozen(input)).toBe(false)
    expect(current).toEqual(saved)
    expect(Object.isFrozen(current)).toBe(true)
    expect(otel.getCurrentContext()).toBeUndefined()
    await otel.flush()

    const spans = spansOf(bodies)
    expect(spans.map((item) => item.name).sort()).toEqual([
      'owned.child',
      'owned.other',
      'owned.saved',
    ])
    expectChild(span(spans, 'owned.child'), span(spans, 'owned.saved'))
  } finally {
    otel.dispose()
  }
})

test('disposing a pending action prevents completion capture/export while its original Promise settles and a new factory exports', async () => {
  const bodies: string[] = []
  const run = createRun()
  const gate = Promise.withResolvers<void>()
  const payload = { pending: true }
  const captures: string[] = []
  let pending: Promise<typeof payload> | undefined
  let first: ReturnType<typeof reatomOpentelemetry> | undefined
  let second: ReturnType<typeof setup> | undefined
  try {
    first = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'no-core-spike',
      retry: { maxRetries: 0 },
      maxBatchSize: 100,
      filter: (target) => target.name.startsWith('dispose.'),
      captureValues: {
        redact(key, value) {
          captures.push(key)
          return value
        },
      },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response('{}', { status: 200 })
      },
    })
    const pendingAction = action(() => {
      const result = gate.promise.then(() => payload)
      pending = result
      return result
    }, 'dispose.pending')
    const returned = run(pendingAction)
    expect(returned).toBe(pending)
    expect(captures).toEqual(['params'])

    first.dispose()
    gate.resolve()
    expect(await returned).toBe(payload)
    await Promise.resolve()
    expect(captures).toEqual(['params'])
    await first.flush()
    expect(bodies).toHaveLength(0)

    second = setup((name) => name === 'dispose.second')
    const later = action(() => ({ second: true }), 'dispose.second')
    const laterResult = second.run(later)
    expect(laterResult).toEqual({ second: true })
    await second.otel.flush()
    expect(second.bodies).toHaveLength(1)
    expect(spansOf(second.bodies).map((item) => item.name)).toEqual([
      'dispose.second',
    ])
  } finally {
    gate.resolve()
    await pending
    first?.dispose()
    second?.otel.dispose()
  }
})

test('ordinary await wrap has no implicit adapter-context reentry', async () => {
  const { otel, bodies, run } = setup((name) => name.startsWith('negative.'))
  const gate = Promise.withResolvers<void>()
  const payload = { child: true }
  let pending: Promise<typeof payload> | undefined
  try {
    const child = action(() => payload, 'negative.child')
    let saved: ReturnType<typeof otel.getCurrentContext>
    let resumed: ReturnType<typeof otel.getCurrentContext>
    const parent = action(() => {
      const result = (async () => {
        saved = otel.getCurrentContext()
        await wrap(gate.promise)
        resumed = otel.getCurrentContext()
        return child()
      })()
      pending = result
      return result
    }, 'negative.parent')

    const returned = run(() => otel.startTrace('negative.root', () => parent()))
    expect(returned).toBe(pending)
    expect(saved).toBeDefined()
    expect(run(otel.getCurrentContext)).toBeUndefined()
    gate.resolve()
    expect(await returned).toBe(payload)
    expect(resumed).toBeUndefined()

    await otel.flush()
    expect(bodies).toHaveLength(1)
    const spans = spansOf(bodies)
    expect(spans.map((item) => item.name).sort()).toEqual([
      'negative.child',
      'negative.parent',
      'negative.root',
    ])
    const root = span(spans, 'negative.root')
    const parentSpan = span(spans, 'negative.parent')
    const childSpan = span(spans, 'negative.child')
    expectChild(parentSpan, root)
    expect(childSpan.parentSpanId).toBeUndefined()
    expect(childSpan.traceId).not.toBe(parentSpan.traceId)
  } finally {
    gate.resolve()
    await pending
    otel.dispose()
  }
})
