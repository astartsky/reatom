import { expect, test } from 'test'

import { withConnectHook } from '../extensions'
import type { AtomLike, AtomMeta } from './'
import {
  _copy,
  _read,
  atom,
  computed,
  isConnected,
  notify,
  withMiddleware,
} from './'

type Observer =
  NonNullable<AtomMeta['_executionObservers']> extends Set<infer T> ? T : never

const observe = (target: AtomLike, observer: Observer) => {
  const observers = (target.__reatom._executionObservers ??= new Set())
  observers.add(observer)
  return () => observers.delete(observer)
}

test.each([
  ['begin', false],
  ['begin', true],
  ['end', false],
  ['end', true],
] as const)(
  '%s phase, catches=%s: computed refuses observation before entering its body and later tracks its source',
  (phase, catches) => {
    let aCalls = 0
    let bCalls = 0
    const observed: number[] = []
    const a = atom(() => {
      aCalls++
      return 1
    }, 'recoverySource')
    const offset = atom(1, 'recoveryOffset')
    const b = computed(() => {
      bCalls++
      const value = offset()
      try {
        return a() + value
      } catch (error) {
        if (catches) return -1
        throw error
      }
    }, 'recoveryComputed')
    const observer: Observer = (event) => {
      if (event.kind !== 'init') return
      const call = () => {
        observed.push(b())
      }
      if (phase === 'begin') call()
      return () => {
        if (phase === 'end') call()
      }
    }
    observe(a, observer)

    // The observer never enters b, so there is no fallback or error to cache.
    expect(a()).toBe(1)
    expect(aCalls).toBe(1)
    expect(bCalls).toBe(0)
    expect(observed).toEqual([])
    expect(_read(b)).toBeUndefined()

    expect(b()).toBe(2)
    expect(bCalls).toBe(1)
    expect(b()).toBe(2)
    expect(bCalls).toBe(1)
    a.set(4)
    expect(b()).toBe(5)
    expect(bCalls).toBe(2)
    offset.set(2)
    expect(b()).toBe(6)
    expect(bCalls).toBe(3)
    // No stuck processing on either atom.
    expect(a.__reatom.processing).toBe(0)
    expect(b.__reatom.processing).toBe(0)
    expect(aCalls).toBe(1) // set() never re-runs an initializer
  },
)

test.each(['begin', 'end'] as const)(
  '%s phase: plain lazy intermediate remains uninitialized until its first application read',
  (phase) => {
    let aCalls = 0
    let bInits = 0
    const a = atom(() => {
      aCalls++
      return 1
    }, 'lazySource')
    const b = atom(() => {
      bInits++
      return a() + 1
    }, 'lazyIntermediate')
    const observer: Observer = (event) => {
      if (event.kind !== 'init') return
      const call = () => {
        b() // contained by the hook's observer wrapper
      }
      if (phase === 'begin') call()
      return () => {
        if (phase === 'end') call()
      }
    }
    observe(a, observer)

    expect(a()).toBe(1)
    expect(aCalls).toBe(1)
    expect(bInits).toBe(0)
    expect(_read(b)).toBeUndefined()
    expect(b()).toBe(2)
    expect(bInits).toBe(1)
    expect(b()).toBe(2)
    expect(bInits).toBe(1)
    a.set(4)
    expect(b()).toBe(2)
    expect(bInits).toBe(1)
    // Direct writes keep working.
    b.set(9)
    expect(b()).toBe(9)
    expect(a.__reatom.processing).toBe(0)
    expect(b.__reatom.processing).toBe(0)
  },
)

test('ordinary app error in an unrelated computed keeps its identical error cache', () => {
  const appError = new Error('application failure')
  let bCalls = 0
  const a = atom(() => 1, 'plainSource')
  const b = computed(() => {
    bCalls++
    throw appError
  }, 'unrelatedErrorComputed')
  let reads = 0
  observe(a, (event) => {
    if (event.kind !== 'init') return
    reads++
    b() // its error is contained by the hook
  })

  a()
  expect(reads).toBe(1)
  expect(bCalls).toBe(0)
  expect(_read(b)).toBeUndefined()

  let caught: unknown
  try {
    b()
  } catch (error) {
    caught = error
  }
  // The identical original error is preserved by the ordinary error cache.
  expect(caught === appError).toBe(true)
  expect(bCalls).toBe(1) // no recomputation for unrelated app errors
})

test.each([
  ['begin', false],
  ['begin', true],
  ['end', false],
  ['end', true],
] as const)(
  '%s phase, extended=%s: a refused subscribed read preserves its existing dependency lifecycle',
  (phase, extended) => {
    let connects = 0
    let cleanups = 0
    let lateConnects = 0
    let lateCleanups = 0
    const enabled = atom(false, 'recoveryEnabled').extend(
      withConnectHook(() => {
        connects++
        return () => {
          cleanups++
        }
      }),
    )
    const late = atom(1, 'confirmedLateDependency').extend(
      withConnectHook(() => {
        lateConnects++
        return () => {
          lateCleanups++
        }
      }),
    )
    const source = atom(() => 1, 'subscribedRecoverySource')
    const derived = computed(
      () => (enabled() ? source() + late() : late() - 1),
      'subscribedRecoveryComputed',
    )
    if (extended)
      derived.extend(
        withMiddleware(
          () =>
            (next, ...args) =>
              next(...args),
        ),
      )
    const values: number[] = []
    const errors: unknown[] = []
    const unsubscribe = derived.subscribe(
      (value) => values.push(value),
      (error) => errors.push(error),
    )
    const detach = observe(source, ({ kind }) => {
      if (kind !== 'init') return
      if (phase === 'begin') derived()
      return () => {
        if (phase === 'end') derived()
      }
    })
    try {
      notify()
      expect([connects, cleanups]).toEqual([1, 0])
      expect([lateConnects, lateCleanups]).toEqual([1, 0])
      enabled.set(true)
      expect(source()).toBe(1)
      notify()
      expect(values).toEqual([0, 2])
      expect(errors).toEqual([])
      expect([connects, cleanups]).toEqual([1, 0])
      expect([lateConnects, lateCleanups]).toEqual([1, 0])
      source.set(4)
      notify()
      expect(values).toEqual([0, 2, 5])
      expect(isConnected(source)).toBe(true)
      expect(isConnected(enabled)).toBe(true)
      expect([connects, cleanups]).toEqual([1, 0])
      expect([lateConnects, lateCleanups]).toEqual([1, 0])
    } finally {
      detach()
      unsubscribe()
      notify()
    }
    expect(isConnected(source)).toBe(false)
    expect(isConnected(enabled)).toBe(false)
    expect([connects, cleanups]).toEqual([1, 1])
    expect([lateConnects, lateCleanups]).toEqual([1, 1])
    expect(isConnected(late)).toBe(false)
  },
)
test('begin: explicit write inside the observer survives the guard refusal', () => {
  let aCalls = 0
  let refusals = 0
  let updaterCalls = 0
  const a = atom(() => {
    aCalls++
    return 1
  }, 'writeSource')
  const b = atom(0, 'writeTarget')
  expect(b()).toBe(0)
  const written: number[] = []
  const updater = (previous: number) => {
    updaterCalls++
    try {
      // Exactly one read: it hits the real observation refusal
      // because the updater runs inside a's init observer.
      return previous + a()
    } catch {
      refusals++
      return previous + 1
    }
  }
  const observer: Observer = (event) => {
    if (event.kind !== 'init') return
    written.push(b.set(updater))
  }
  observe(a, observer)

  a()
  // Assertions outside the observer.
  expect(aCalls).toBe(1) // a init ran exactly once
  expect(refusals).toBe(1) // the real guard refusal, caught by the updater
  expect(updaterCalls).toBe(1)
  expect(written).toEqual([1])
  // The explicit write's outcome must not be rolled back by the guard refusal.
  expect(b()).toBe(1)
})

test.each([false, true])(
  'a refused read leaves pending self-writes to ordinary computation; copy=%s',
  (copy) => {
    const trigger = atom(0, 'retryTrigger')
    const source = atom(() => 1, 'retryNewSource')
    const fresh = atom(7, 'retryNewDependency')
    let armed = false
    let calls = 0
    const derived = computed(() => {
      calls++
      const current = trigger()
      if (!armed) return current
      if (current !== 0) trigger.set(0)
      fresh()
      return source()
    }, 'retryAfterBodyWrite')
    expect(derived()).toBe(0)
    armed = true
    trigger.set(1)
    observe(source, ({ kind }) => {
      if (kind === 'init') derived()
    })
    expect(source()).toBe(1)
    expect(trigger()).toBe(1)
    const callsAfterRefusal = calls
    expect(callsAfterRefusal).toBe(1)
    if (copy) {
      const frame = _read(derived)!
      // Ordinary frame copying must preserve the pending computation.
      expect(_copy(frame) === frame).toBe(false)
    }
    expect(derived()).toBe(1)
    expect(calls).toBe(callsAfterRefusal + 2)
    expect(derived()).toBe(1)
    expect(calls).toBe(callsAfterRefusal + 2)
    source.set(2)
    expect(derived()).toBe(2)
    expect(derived.__reatom.processing).toBe(0)
  },
)

test('unsubscribe after a refused read releases existing dependencies without executing its body', () => {
  let connects = 0
  let cleanups = 0
  const enabled = atom(false, 'pendingEnabled').extend(
    withConnectHook(() => {
      connects++
      return () => {
        cleanups++
      }
    }),
  )
  const source = atom(() => 1, 'pendingSource')
  let calls = 0
  const derived = computed(() => {
    calls++
    return enabled() ? source() : 0
  }, 'pendingDerived')
  const values: number[] = []
  const unsubscribe = derived.subscribe((value) => values.push(value))
  observe(source, ({ kind }) => {
    if (kind === 'init') derived()
  })
  try {
    notify()
    expect([connects, cleanups]).toEqual([1, 0])
    enabled.set(true)
    expect(source()).toBe(1)
    expect(calls).toBe(1)
  } finally {
    unsubscribe()
  }
  notify()
  expect(values).toEqual([0])
  expect(calls).toBe(1)
  expect([connects, cleanups]).toEqual([1, 1])
  expect(isConnected(enabled)).toBe(false)
})

test('a refused read leaves dependency validation to the next application call', () => {
  const enabled = atom(false, 'validationEnabled')
  const source = atom(() => 1, 'validationSource')
  let dependencyCalls = 0
  let readerCalls = 0
  const dependency = computed(() => {
    dependencyCalls++
    return enabled() ? source() : undefined
  }, 'validationDependency')
  const reader = computed(() => {
    readerCalls++
    return dependency() === undefined ? 'empty' : 'ready'
  }, 'validationReader')
  expect(reader()).toBe('empty')
  expect([readerCalls, dependencyCalls]).toEqual([1, 1])
  const observed: string[] = []
  observe(source, ({ kind }) => {
    if (kind === 'init') observed.push(reader())
  })
  enabled.set(true)
  expect(source()).toBe(1)
  expect(observed).toEqual([])
  expect([readerCalls, dependencyCalls]).toEqual([1, 1])
  expect(reader()).toBe('ready')
  expect([readerCalls, dependencyCalls]).toEqual([2, 2])
  expect(reader()).toBe('ready')
  expect([readerCalls, dependencyCalls]).toEqual([2, 2])
})

test('a refused observer read does not suppress the subsequent application dependency diff', () => {
  const events: string[] = []
  const left = atom(0, 'normalLeft').extend(
    withConnectHook(() => {
      events.push('left+')
      return () => {
        events.push('left-')
      }
    }),
  )
  const right = atom(1, 'normalRight').extend(
    withConnectHook(() => {
      events.push('right+')
      return () => {
        events.push('right-')
      }
    }),
  )
  const selected = atom(false, 'normalSelected')
  const derived = computed(
    () => (selected() ? right() : left()),
    'normalDerived',
  )
  const source = atom(() => 9, 'normalObservedSource')
  const reads: number[] = []
  const values: number[] = []
  const unsubscribe = derived.subscribe((value) => values.push(value))
  observe(source, ({ kind }) => {
    if (kind === 'init') reads.push(derived())
  })
  try {
    notify()
    expect(events).toEqual(['left+'])
    selected.set(true)
    expect(source()).toBe(9)
    notify()
    expect(reads).toEqual([])
    expect(values).toEqual([0, 1])
    expect(events).toEqual(['left+', 'right+', 'left-'])
  } finally {
    unsubscribe()
    notify()
  }
  expect(events).toEqual(['left+', 'right+', 'left-', 'right-'])
  expect(isConnected(left)).toBe(false)
  expect(isConnected(right)).toBe(false)
})
test.each([
  ['begin', true],
  ['end', true],
  ['begin', false],
  ['end', false],
] as const)(
  '%s phase, refusalFirst=%s: ordinary recursive passes keep the new dependency linked until a real unsubscribe',
  (phase, refusalFirst) => {
    let connects = 0
    let cleanups = 0
    const trigger = atom(0, 'trigger')
    const source = atom(() => 1, 'source')
    const fresh = atom(7, 'fresh').extend(
      withConnectHook(() => {
        connects++
        return () => cleanups++
      }),
    )
    let armed = false
    const derived = computed(() => {
      const n = trigger()
      if (!armed) return 0
      if (n !== 0) {
        trigger.set(0)
        if (refusalFirst) source()
      } else if (!refusalFirst) source()
      return fresh()
    })
    const values: number[] = []
    const observed: number[] = []
    const observer: Observer = (event) => {
      if (event.kind !== 'init') return
      const call = () => {
        observed.push(derived())
      }
      if (phase === 'begin') call()
      return () => {
        if (phase === 'end') call()
      }
    }
    observe(source, observer)

    const unsubscribe = derived.subscribe((value) => values.push(value))
    try {
      notify()
      expect(derived()).toBe(0)

      // Observation must not run either pass. The subsequent application read
      // still executes both orders of self-write and dependency reads.
      armed = true
      trigger.set(1)
      source()
      expect(observed).toEqual([])

      // User value and notifications stay stable.
      expect(derived()).toBe(7)
      notify()
      expect(values).toEqual([0, 7])

      // Each dependency is linked once and cleaned up on real unsubscribe.
      expect(connects).toBe(1)
      expect(isConnected(fresh)).toBe(true)
      const activeLinks = _read(fresh)!.subs.length

      // Inspect real cleanup before asserting, even when multiplicity is wrong.
      unsubscribe()
      notify()
      expect(cleanups).toBe(1)
      expect(activeLinks).toBe(1)
      expect(isConnected(fresh)).toBe(false)
      expect(_read(fresh)!.subs).toHaveLength(0)
    } finally {
      // Safety: if an assertion above threw before the manual unsubscribe.
      unsubscribe()
      notify()
    }
  },
)

test.each([false, true, 'refused'] as const)(
  'recursion-limit cleanup retains no dependencies, observed=%s',
  (observed) => {
    const previous = atom(0, 'limitPrevious')
    const current = atom(0, 'limitCurrent')
    const source = atom(() => 1, 'limitSource')
    let armed = false
    const derived = computed(() => {
      if (!armed) return previous()
      current.set(current() + 1)
      if (observed === 'refused') {
        try {
          source()
        } catch {}
      }
      return current()
    }, 'limitDerived')
    const unsubscribe = derived.subscribe()
    let caught: unknown
    const read = () => {
      try {
        derived()
      } catch (error) {
        caught = error
      }
    }
    const detach = observe(source, ({ kind }) => {
      if (observed && kind === 'init') read()
    })
    try {
      armed = true
      previous.set(1)
      if (observed) source()
      read()
      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toBe('Stuck in recursion')
      expect(derived.__reatom.processing).toBe(0)
      unsubscribe()
      notify()
      expect(isConnected(previous)).toBe(false)
      expect(isConnected(current)).toBe(false)
      expect(_read(previous)!.subs).toHaveLength(0)
      expect(_read(current)!.subs).toHaveLength(0)
    } finally {
      detach()
      unsubscribe()
      notify()
    }
  },
)
