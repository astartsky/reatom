import {
  abortVar,
  action,
  atom,
  bind,
  computed,
  context,
  getCalls,
  isAbort,
  isConnected,
  notify,
  withAbort,
  withAsync,
  withAsyncData,
  withCache,
  withCallHook,
  withChangeHook,
  withComputed,
  withConnectHook,
  withDisconnectHook,
  withParams,
  wrap,
} from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

test.each(['capture', 'throw', 'filtered'] as const)(
  'observer reads do not become application dependencies (%s)',
  async (mode: 'capture' | 'throw' | 'filtered') => {
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    let connects = 0
    let cleanups = 0
    let rawCalls = 0
    let tracedCalls = 0
    const [telemetry, source, raw] = run(() => {
      const telemetry = atom(7, 'compat.telemetry').extend(
        withConnectHook(() => {
          connects++
          return () => {
            cleanups++
          }
        }),
      )
      const source = atom(1, 'compat.source')
      const raw = computed(() => {
        rawCalls++
        return { value: source() }
      }, 'compat.raw')
      return [telemetry, source, raw] as const
    })
    const reads: number[] = []
    const bodies: string[] = []
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'compat',
      filter: (target) =>
        mode !== 'filtered' && target.name === 'compat.traced',
      captureValues: {
        redact: (_key, value) => {
          reads.push(telemetry())
          if (mode === 'throw') throw new Error('redaction failure')
          return value
        },
      },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response(null)
      },
    })
    const traced = run(() =>
      computed(() => {
        tracedCalls++
        return { value: source() }
      }, 'compat.traced'),
    )
    const rawNotifications: number[] = []
    const tracedNotifications: number[] = []
    let unsubscribeRaw = () => {}
    let unsubscribeTraced = () => {}
    try {
      run(() => {
        unsubscribeRaw = raw.subscribe((value) =>
          rawNotifications.push(value.value),
        )
        unsubscribeTraced = traced.subscribe((value) =>
          tracedNotifications.push(value.value),
        )
        notify()
        expect([rawCalls, tracedCalls]).toEqual([1, 1])
        expect(rawNotifications).toEqual([1])
        expect(tracedNotifications).toEqual([1])
        expect(isConnected(source)).toBe(true)
        expect(isConnected(telemetry)).toBe(false)
        if (mode === 'filtered') expect(reads).toEqual([])
        else expect(reads).toContain(7)

        telemetry.set(9)
        notify()
        expect([rawCalls, tracedCalls]).toEqual([1, 1])
        expect(rawNotifications).toEqual([1])
        expect(tracedNotifications).toEqual([1])

        source.set(2)
        notify()
        expect([rawCalls, tracedCalls]).toEqual([2, 2])
        expect(raw()).toEqual({ value: 2 })
        expect(traced()).toEqual({ value: 2 })
        expect(rawNotifications).toEqual([1, 2])
        expect(tracedNotifications).toEqual([1, 2])
        if (mode !== 'filtered') expect(reads).toContain(9)
        expect(isConnected(telemetry)).toBe(false)
        expect([connects, cleanups]).toEqual([0, 0])
      })
      await otel.flush()
      expect(bodies.flatMap(parseSpans).map((span) => span.name)).toEqual(
        mode === 'capture' ? ['compat.traced', 'compat.traced'] : [],
      )
      expect(otel.stats().droppedByReason.observation).toBe(
        mode === 'throw' ? 2 : 0,
      )
    } finally {
      run(() => {
        unsubscribeRaw()
        unsubscribeTraced()
        notify()
      })
      otel.dispose()
    }
    expect(run(() => isConnected(source))).toBe(false)
    expect([connects, cleanups]).toEqual([0, 0])
  },
)

const runSyncParity = async (traced: boolean) => {
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  const bodies: string[] = []
  const otel = traced
    ? reatomOpentelemetry({
        endpoint: 'http://collector.invalid',
        serviceName: 'core-compatibility',
        batchInterval: 100_000,
        maxBatchSize: 100,
        retry: { maxRetries: 0 },
        fetch: async (_url, init) => {
          bodies.push(String(init?.body))
          return new Response('{}')
        },
      })
    : undefined
  const journal: string[] = []
  let detachFirst = () => {}
  let detachSecond = () => {}
  let detachReadonly = () => {}
  let detachConsumer = () => {}
  try {
    let readonlyCalls = 0
    const source = atom(1, 'r14.sync.source').extend(
      withConnectHook(() => {
        journal.push('connect')
      }),
      withDisconnectHook(() => journal.push('disconnect')),
      withChangeHook((next, previous) =>
        journal.push(`change:${previous}->${next}`),
      ),
    )
    const readonly = computed(() => {
      readonlyCalls++
      return source() % 2
    }, 'r14.sync.readonly')
    const readonlyValues: number[] = []
    const writable = atom(0, 'r14.sync.writable').extend(
      withParams((value: number) => value + 1),
    )
    let writableComputedCalls = 0
    const exactError = new Error('r14.sync.exact-error')
    const writableComputed = atom(1, 'r14.sync.writable-computed').extend(
      withComputed((value) => {
        if (value < 0) throw exactError
        writableComputedCalls++
        return value * 2
      }),
    )
    let diamondCalls = 0
    const left = computed(() => source() + 10, 'r14.sync.left')
    const right = computed(() => source() * 2, 'r14.sync.right')
    const diamond = computed(() => {
      diamondCalls++
      return left() + right()
    }, 'r14.sync.diamond')
    const calls: string[] = []
    const work = action((value: number) => {
      source.set(value)
      source.set(value + 1)
      return value + 1
    }, 'r14.sync.work').extend(
      withParams((value: number) => value + 1),
      withCallHook((payload, params) =>
        calls.push(`call:${payload}:${params}`),
      ),
    )

    expect([readonlyCalls, diamondCalls, writableComputedCalls]).toEqual([
      0, 0, 0,
    ])
    expect(run(() => readonly())).toBe(1)
    expect(readonlyCalls).toBe(1)
    expect(run(() => readonly())).toBe(1)
    expect(readonlyCalls).toBe(1)
    const values: number[] = []
    detachReadonly = run(() =>
      readonly.subscribe((value) => readonlyValues.push(value)),
    )
    detachFirst = run(() => diamond.subscribe((value) => values.push(value)))
    detachSecond = run(() => diamond.subscribe((value) => values.push(value)))
    expect(run(() => work(1))).toBe(3)
    expect(run(() => getCalls(work))).toEqual([{ params: [2], payload: 3 }])
    run(notify)
    expect(run(() => [source(), readonly(), diamond()])).toEqual([3, 1, 19])
    expect(readonlyCalls).toBe(2)
    expect(diamondCalls).toBe(2)
    expect(values).toEqual([13, 13, 19, 19])
    expect(calls).toEqual(['call:3:2'])
    expect(run(() => writable.set(4))).toBe(5)
    expect(run(writable)).toBe(5)
    expect(writable.extend(withChangeHook(() => {}))).toBe(writable)
    expect(run(writableComputed)).toBe(2)
    expect(run(() => writableComputed.set(3))).toBe(6)
    expect(run(() => writableComputed.set((previous) => previous + 1))).toBe(26)
    expect(writableComputedCalls).toBe(5)
    const fails = action(() => {
      throw exactError
    }, 'r14.sync.error')
    let caught: unknown
    try {
      run(fails)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(exactError)
    for (const operation of [
      () => writableComputed.set(-1),
      () => writableComputed(),
    ]) {
      let computedError: unknown
      try {
        run(operation)
      } catch (error) {
        computedError = error
      }
      expect(computedError).toBe(exactError)
    }

    run(() => source.set(5))
    run(notify)
    expect(readonlyCalls).toBe(3)
    expect(readonlyValues).toEqual([1])

    run(detachFirst)
    run(detachSecond)
    run(detachReadonly)
    run(notify)
    const detachedSource = atom(0, 'r14.sync.detached-source')
    let detachedCalls = 0
    const detachedConsumer = computed(() => {
      detachedCalls++
      return detachedSource()
    }, 'r14.sync.detached-consumer')
    detachConsumer = run(() => detachedConsumer.subscribe(() => {}))
    expect(detachedCalls).toBe(1)
    run(detachConsumer)
    run(() => {
      detachedSource.set(1)
      notify()
    })
    expect(detachedCalls).toBe(1)
    expect(run(() => getCalls(work))).toEqual([])
    expect(journal).toEqual([
      'change:1->2',
      'change:2->3',
      'connect',
      'change:3->5',
      'disconnect',
    ])
    await otel?.flush()
    return {
      journal,
      values,
      calls,
      readonlyCalls,
      diamondCalls,
      writableComputedCalls,
      bodies,
    }
  } finally {
    run(detachFirst)
    run(detachSecond)
    run(detachReadonly)
    run(detachConsumer)
    run(notify)
    otel?.dispose()
  }
}

test('R14 sync consumers preserve lazy, hooks, params, calls, and batched diamond parity', async () => {
  const expected = {
    journal: [
      'change:1->2',
      'change:2->3',
      'connect',
      'change:3->5',
      'disconnect',
    ],
    values: [13, 13, 19, 19, 25, 25],
    calls: ['call:3:2'],
    readonlyCalls: 3,
    diamondCalls: 3,
    writableComputedCalls: 6,
  }
  const raw = await runSyncParity(false)
  const traced = await runSyncParity(true)
  expect(raw).toMatchObject(expected)
  expect(traced).toMatchObject(expected)
  expect(traced.bodies.flatMap(parseSpans).map((span) => span.name)).toContain(
    'r14.sync.work',
  )
})

const createPendingCleanup = () => {
  const releases: Array<() => void> = []
  const pending: Promise<unknown>[] = []
  return {
    defer<Value>(cleanupValue: Value) {
      const gate = Promise.withResolvers<Value>()
      releases.push(() => gate.resolve(cleanupValue))
      return gate
    },
    track<Value>(promise: Promise<Value>): Promise<Value> {
      pending.push(promise.catch(() => undefined))
      return promise
    },
    async finish() {
      for (const release of releases) release()
      await Promise.all(pending)
    },
  }
}

const runAsyncParity = async (traced: boolean) => {
  const tasks = createPendingCleanup()
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  const bodies: string[] = []
  const otel = traced
    ? reatomOpentelemetry({
        endpoint: 'http://collector.invalid',
        serviceName: 'core-compatibility',
        batchInterval: 100_000,
        maxBatchSize: 100,
        retry: { maxRetries: 0 },
        fetch: async (_url, init) => {
          bodies.push(String(init?.body))
          return new Response('{}')
        },
      })
    : undefined
  const lifecycle: string[] = []
  try {
    let saveBodies = 0
    const save = action(async (value: number) => {
      saveBodies++
      await wrap(Promise.resolve())
      if (value < 0) throw new Error('rejected')
      return value * 2
    }, 'r14.async.save').extend(
      withAsync({ status: true, cacheParams: true }),
      withCache(),
    )
    save.onFulfill.extend(
      withCallHook(({ payload, params }) =>
        lifecycle.push(`fulfill:${payload}:${params}`),
      ),
    )
    save.onReject.extend(
      withCallHook(({ error, params }) =>
        lifecycle.push(`reject:${(error as Error).message}:${params}`),
      ),
    )
    save.onSettle.extend(
      withCallHook((call) =>
        lifecycle.push(
          'error' in call
            ? `settle:${(call.error as Error).message}:${call.params}`
            : `settle:${call.payload}:${call.params}`,
        ),
      ),
    )
    const first = tasks.track(run(() => save(2)))
    expect(first).toBeInstanceOf(Promise)
    expect(run(save.pending)).toBe(1)
    expect(run(save.status)).toMatchObject({
      isPending: true,
      isFirstPending: true,
    })
    expect(await first).toBe(4)
    expect(run(save.ready)).toBe(true)
    expect(run(save.status)).toMatchObject({
      isFulfilled: true,
      isSettled: true,
    })
    expect(await tasks.track(run(() => save.retry()))).toBe(4)
    expect(saveBodies).toBe(1)
    expect(run(save.params)).toEqual([2])
    run(() => save.cacheAtom.deleteWithParams([2]))
    expect(await tasks.track(run(() => save(2)))).toBe(4)
    expect(saveBodies).toBe(2)
    const invalidated = run(() => save.cacheAtom.invalidate())
    if (invalidated === null)
      throw new Error('Expected invalidation to refetch')
    expect(await tasks.track(invalidated)).toBe(4)
    expect(saveBodies).toBe(3)
    await expect(tasks.track(run(() => save(-1)))).rejects.toThrow('rejected')
    expect(run(save.error)?.message).toBe('rejected')
    expect(run(save.status)).toMatchObject({
      isRejected: true,
      isSettled: true,
    })

    let manualGate = tasks.defer<void>(undefined)
    let manualBodies = 0
    let manualEffects = 0
    let inner!: Promise<number>
    const manual = action(
      () =>
        (inner = tasks.track(
          (async () => {
            manualBodies++
            await wrap(manualGate.promise)
            manualEffects++
            return 7
          })(),
        )),
      'r14.async.manual',
    ).extend(withAbort('manual'), withAsync({ status: true }))
    const manualLifecycle: string[] = []
    manual.onReject.extend(withCallHook(() => manualLifecycle.push('reject')))
    manual.onSettle.extend(
      withCallHook((call) =>
        manualLifecycle.push(
          'error' in call && isAbort(call.error) ? 'abort' : 'fulfilled',
        ),
      ),
    )
    const pendingManual = tasks.track(run(manual))
    const abortedInner = inner.catch((error) => error)
    run(() => manual.abort('stop'))
    manualGate.resolve()
    await expect(pendingManual).rejects.toBeDefined()
    expect(isAbort(await abortedInner)).toBe(true)
    expect(manualEffects).toBe(0)
    expect(manualLifecycle).toEqual(['abort'])
    expect(run(manual.pending)).toBe(0)
    expect(run(manual.error)).toBeUndefined()
    expect(run(manual.status).isRejected).toBe(false)
    manualGate = tasks.defer<void>(undefined)
    const positiveManual = tasks.track(run(manual))
    manualGate.resolve()
    expect(await positiveManual).toBe(7)
    expect(manualEffects).toBe(1)
    await expect
      .poll(() => manualLifecycle.slice())
      .toEqual(['abort', 'fulfilled'])
    expect(run(manual.pending)).toBe(0)
    expect(run(manual.status).isFulfilled).toBe(true)

    const gates = new Map<number, PromiseWithResolvers<number>>()
    let resourceBodies = 0
    const resourceParam = atom(1, 'r14.async.resource-param')
    const resource = computed(
      () =>
        tasks.track(
          (async () => {
            resourceBodies++
            const value = resourceParam()
            const gate = tasks.defer(0)
            gates.set(value, gate)
            return await wrap(gate.promise)
          })(),
        ),
      'r14.async.resource',
    ).extend(withAsyncData({ initState: 0 }), withCache())
    const stale = tasks.track(run(resource)).catch(() => undefined)
    run(() => {
      resourceParam.set(2)
      notify()
    })
    const latest = tasks.track(run(resource))
    gates.get(2)!.resolve(20)
    expect(await latest).toBe(20)
    gates.get(1)!.resolve(10)
    await stale
    expect(run(resource.data)).toBe(20)
    expect(resourceBodies).toBe(2)
    run(() => resource.reset())
    expect(run(resource.data)).toBe(0)
    expect(resourceBodies).toBe(2)

    await otel?.flush()
    return {
      lifecycle,
      saveBodies,
      manualBodies,
      manualEffects,
      resourceBodies,
      bodies,
    }
  } finally {
    try {
      await tasks.finish()
    } finally {
      otel?.dispose()
    }
  }
}

test('R14 async extensions preserve status, retry, rejection, abort, latest data, and reset parity', async () => {
  const expected = {
    lifecycle: [
      'fulfill:4:2',
      'settle:4:2',
      'fulfill:4:2',
      'settle:4:2',
      'fulfill:4:2',
      'settle:4:2',
      'fulfill:4:2',
      'settle:4:2',
      'reject:rejected:-1',
      'settle:rejected:-1',
    ],
    saveBodies: 4,
    manualBodies: 2,
    manualEffects: 1,
    resourceBodies: 2,
  }
  const raw = await runAsyncParity(false)
  const traced = await runAsyncParity(true)
  expect(raw).toMatchObject(expected)
  expect(traced).toMatchObject(expected)
  expect(traced.bodies.flatMap(parseSpans).map((span) => span.name)).toContain(
    'r14.async.save',
  )
})

const runAbortAndResetParity = async (traced: boolean) => {
  const tasks = createPendingCleanup()
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  const bodies: string[] = []
  const otel = traced
    ? reatomOpentelemetry({
        endpoint: 'http://collector.invalid',
        serviceName: 'core-compatibility',
        batchInterval: 100_000,
        maxBatchSize: 100,
        retry: { maxRetries: 0 },
        fetch: async (_url, init) => {
          bodies.push(String(init?.body))
          return new Response('{}')
        },
      })
    : undefined
  try {
    const firstGate = tasks.defer<void>(undefined)
    const firstStarts: number[] = []
    const firstEffects: number[] = []
    const first = action(
      (value: number) =>
        tasks.track(
          (async () => {
            firstStarts.push(value)
            await wrap(firstGate.promise)
            firstEffects.push(value)
            return value
          })(),
        ),
      'r14.abort.first',
    ).extend(withAbort('first-in-win'))
    const firstRun = tasks.track(run(() => first(1)))
    let rejectedSecond: unknown
    try {
      run(() => first(2))
    } catch (error) {
      rejectedSecond = error
    }
    expect(firstStarts).toEqual([1])
    firstGate.resolve()
    expect(await firstRun).toBe(1)
    expect(isAbort(rejectedSecond)).toBe(true)
    expect(firstEffects).toEqual([1])
    expect(await tasks.track(run(() => first(3)))).toBe(3)
    expect(firstEffects).toEqual([1, 3])

    let childPromise!: Promise<unknown>
    const childGate = tasks.defer<void>(undefined)
    const child = action(async () => {
      await wrap(childGate.promise)
      return 'child'
    }, 'r14.abort.child')
    const parent = action(async () => {
      childPromise = tasks.track(abortVar.createAndRun(child))
      return 'parent'
    }, 'r14.abort.finally').extend(withAbort('finally'))
    expect(await tasks.track(run(parent))).toBe('parent')
    expect(isAbort(await childPromise.catch((error: unknown) => error))).toBe(
      true,
    )

    const positiveParentGate = tasks.defer<void>(undefined)
    const positiveChildGate = tasks.defer<void>(undefined)
    let positiveChild!: Promise<unknown>
    const ongoingChild = action(async () => {
      await wrap(positiveChildGate.promise)
      return 'child-complete'
    }, 'r14.abort.ongoing-child')
    const ongoingParent = action(async () => {
      positiveChild = tasks.track(abortVar.createAndRun(ongoingChild))
      await wrap(positiveParentGate.promise)
      return 'parent-complete'
    }, 'r14.abort.ongoing-parent').extend(withAbort('finally'))
    const parentPending = tasks.track(run(ongoingParent))
    positiveChildGate.resolve()
    expect(await positiveChild).toBe('child-complete')
    positiveParentGate.resolve()
    expect(await parentPending).toBe('parent-complete')

    const downstream = atom(0, 'r14.reset.downstream')
    const readOld = run(
      action(() => {
        downstream()
        return bind(downstream)
      }, 'r14.reset.read-old'),
    )
    expect(readOld()).toBe(0)
    const resetGate = tasks.defer<void>(undefined)
    const old = tasks.track(
      run(async () => {
        const pending = wrap(resetGate.promise)
        context.reset()
        await pending
        downstream.set(1)
        return 1
      }),
    )
    resetGate.resolve()
    expect(isAbort(await old.catch((error) => error))).toBe(true)
    expect(readOld()).toBe(0)
    expect(run(downstream)).toBe(0)
    const newRun = context.start(() =>
      bind(<T>(callback: () => T) => callback()),
    )
    expect(newRun(downstream)).toBe(0)
    const positive = action(async () => {
      await wrap(Promise.resolve())
      downstream.set(2)
      return 2
    }, 'r14.reset.positive')
    expect(await tasks.track(run(positive))).toBe(2)
    expect(run(downstream)).toBe(2)
    expect(readOld()).toBe(0)
    expect(newRun(downstream)).toBe(0)

    await otel?.flush()
    return { firstStarts, firstEffects, reset: run(downstream), bodies }
  } finally {
    try {
      await tasks.finish()
    } finally {
      otel?.dispose()
    }
  }
}

test('R14 first-in-win, finally children, and reset-before-wrap preserve parity', async () => {
  const expected = {
    firstStarts: [1, 3],
    firstEffects: [1, 3],
    reset: 2,
  }
  const raw = await runAbortAndResetParity(false)
  const traced = await runAbortAndResetParity(true)
  expect(raw).toMatchObject(expected)
  expect(traced).toMatchObject(expected)
  expect(traced.bodies.flatMap(parseSpans).map((span) => span.name)).toContain(
    'r14.abort.first',
  )
})

const runPolicyParity = async (traced: boolean) => {
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  const application: string[] = []
  const manualBodies: string[] = []
  const manualOtel = traced
    ? reatomOpentelemetry({
        endpoint: 'http://collector.invalid',
        serviceName: 'core-compatibility',
        filter: () => false,
        batchInterval: 100_000,
        maxBatchSize: 100,
        retry: { maxRetries: 0 },
        fetch: async (_url, init) => {
          manualBodies.push(String(init?.body))
          return new Response('{}')
        },
      })
    : undefined
  try {
    const filtered = action((value: number) => {
      application.push(`filtered:${value}`)
      return value
    }, 'r14.policy.filtered')
    const makeManualBefore = () => {
      const target = action((value: number) => {
        application.push(`before:${value}`)
        return value
      }, 'r14.policy.before')
      if (manualOtel) target.extend(manualOtel.withOTel())
      return target.extend(
        withParams((value: number) => value + 1),
        () => ({ marker: 'before' as const }),
      )
    }
    const makeManualAfter = () => {
      const target = action((value: number) => {
        application.push(`after:${value}`)
        return value
      }, 'r14.policy.after').extend(
        withParams((value: number) => value + 1),
        () => ({ marker: 'after' as const }),
      )
      if (manualOtel) target.extend(manualOtel.withOTel())
      return target
    }
    const manualBefore = makeManualBefore()
    const manualAfter = makeManualAfter()
    expect(run(() => filtered(1))).toBe(1)
    expect(run(() => manualBefore(1))).toBe(2)
    expect(run(() => manualAfter(1))).toBe(2)
    expect([manualBefore.marker, manualAfter.marker]).toEqual([
      'before',
      'after',
    ])
    if (manualOtel) {
      expect(manualBefore.extend(manualOtel.withOTel())).toBe(manualBefore)
      expect(manualAfter.extend(manualOtel.withOTel())).toBe(manualAfter)
      await manualOtel.flush()
      expect(manualBodies.flatMap(parseSpans).map((span) => span.name)).toEqual(
        ['r14.policy.before', 'r14.policy.after'],
      )
    }
    const disposed = action((value: number) => {
      application.push(`disposed:${value}`)
      return value
    }, 'r14.policy.disposed')
    if (manualOtel) disposed.extend(manualOtel.withOTel())
    expect(run(() => disposed(2))).toBe(2)
    await manualOtel?.flush()
    if (traced)
      expect(manualBodies.flatMap(parseSpans).map((span) => span.name)).toEqual(
        ['r14.policy.before', 'r14.policy.after', 'r14.policy.disposed'],
      )
    manualOtel?.dispose()
    expect(run(() => disposed(3))).toBe(3)
    if (traced) expect(manualBodies.flatMap(parseSpans)).toHaveLength(3)

    const reattachedBodies: string[] = []
    const reattachedOtel = traced
      ? reatomOpentelemetry({
          endpoint: 'http://collector.invalid',
          serviceName: 'core-compatibility',
          batchInterval: 100_000,
          maxBatchSize: 100,
          retry: { maxRetries: 0 },
          fetch: async (_url, init) => {
            reattachedBodies.push(String(init?.body))
            return new Response('{}')
          },
        })
      : undefined
    try {
      const reattached = action((value: number) => {
        application.push(`reattached:${value}`)
        return value
      }, 'r14.policy.reattached')
      expect(run(() => reattached(4))).toBe(4)
      await reattachedOtel?.flush()
      if (traced)
        expect(
          reattachedBodies.flatMap(parseSpans).map((span) => span.name),
        ).toEqual(['r14.policy.reattached'])
    } finally {
      reattachedOtel?.dispose()
    }
  } finally {
    manualOtel?.dispose()
  }

  const capacityBodies: string[] = []
  const capacityOtel = traced
    ? reatomOpentelemetry({
        endpoint: 'http://collector.invalid',
        serviceName: 'core-compatibility',
        maxQueueSize: 1,
        maxBatchSize: 100,
        batchInterval: 100_000,
        retry: { maxRetries: 0 },
        fetch: async (_url, init) => {
          capacityBodies.push(String(init?.body))
          return new Response('{}')
        },
      })
    : undefined
  try {
    const capacity = action((value: { readonly id: number }) => {
      application.push(`capacity:${value.id}`)
      return value
    }, 'r14.policy.capacity')
    const first = { id: 1 }
    const second = { id: 2 }
    expect(run(() => capacity(first))).toBe(first)
    expect(run(() => capacity(second))).toBe(second)
    if (capacityOtel) {
      expect(capacityOtel.stats()).toMatchObject({
        active: 0,
        queued: 1,
        exported: 0,
        dropped: 1,
        droppedByReason: { capacity: 1 },
      })
      await capacityOtel.flush()
      expect(
        capacityBodies.flatMap(parseSpans).map((span) => span.name),
      ).toEqual(['r14.policy.capacity'])
      expect(capacityOtel.stats()).toMatchObject({
        active: 0,
        queued: 0,
        inFlight: 0,
        exported: 1,
        dropped: 1,
      })
    }
  } finally {
    capacityOtel?.dispose()
  }
  return { application }
}

test('R14 filtered, admission-rejected, disposed, reattached, and local opt-in consumers preserve parity', async () => {
  const expected = {
    application: [
      'filtered:1',
      'before:2',
      'after:2',
      'disposed:2',
      'disposed:3',
      'reattached:4',
      'capacity:1',
      'capacity:2',
    ],
  }
  expect(await runPolicyParity(false)).toEqual(expected)
  expect(await runPolicyParity(true)).toEqual(expected)
})
