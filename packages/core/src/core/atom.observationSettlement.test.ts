import { expect, test } from 'test'

import { withConnectHook } from '../extensions'
import type { AtomLike, AtomMeta } from './'
import { _read, atom, computed, isConnected, notify } from './'

type Observer =
  NonNullable<AtomMeta['_executionObservers']> extends Set<infer T> ? T : never

const observe = (target: AtomLike, observer: Observer) => {
  const observers = (target.__reatom._executionObservers ??= new Set())
  observers.add(observer)
  return () => observers.delete(observer)
}

test('refused observation leaves ordinary error caching and dependency changes intact', () => {
  const events: string[] = []
  const left = atom(0, 'left').extend(
    withConnectHook(() => {
      events.push('left+')
      return () => {
        events.push('left-')
      }
    }),
  )
  const right = atom(1, 'right').extend(
    withConnectHook(() => {
      events.push('right+')
      return () => {
        events.push('right-')
      }
    }),
  )
  const trigger = atom(false, 'trigger')
  const appError = new Error('application failure')
  let calls = 0
  const reader = computed(() => {
    calls++
    if (!trigger()) return left()
    right()
    throw appError
  }, 'errorReader')
  const source = atom(() => 1, 'errorSource')
  const detach = observe(source, () => {
    reader()
  })
  const unsubscribe = reader.subscribe(
    () => {},
    () => {},
  )
  try {
    notify()
    expect(events).toEqual(['left+'])
    trigger.set(true)
    source()
    expect(calls).toBe(1)
    expect(isConnected(left)).toBe(true)
    expect(isConnected(right)).toBe(false)
    expect(() => reader()).toThrow(appError)
    expect(calls).toBe(2)
    expect(isConnected(left)).toBe(false)
    expect(isConnected(right)).toBe(true)
    notify()
    expect(events).toEqual(['left+', 'right+', 'left-'])
    let caught: unknown
    try {
      reader()
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(appError)
    expect(calls).toBe(2)
  } finally {
    detach()
    unsubscribe()
    notify()
  }
  expect(events).toEqual(['left+', 'right+', 'left-', 'right-'])
  expect(isConnected(left)).toBe(false)
  expect(isConnected(right)).toBe(false)
})

test('refused observation leaves equal-dependency validation and connections intact', () => {
  let depCalls = 0
  let readerCalls = 0
  let connects = 0
  let cleanups = 0
  const input = atom(1, 'input')
  const dep = computed(() => {
    depCalls++
    input()
    return 0
  }, 'equalDep').extend(
    withConnectHook(() => {
      connects++
      return () => {
        cleanups++
      }
    }),
  )
  const reader = computed(() => {
    readerCalls++
    return dep()
  }, 'validatedReader')
  const source = atom(() => 1, 'validationSource')
  const observed: number[][] = []
  const detach = observe(source, () => {
    reader()
    observed.push([depCalls, readerCalls])
  })
  const unsubscribe = reader.subscribe(() => {})
  try {
    notify()
    expect([depCalls, readerCalls, connects, cleanups]).toEqual([1, 1, 1, 0])
    input.set(2)
    source()
    expect(observed).toEqual([])
    expect([depCalls, readerCalls]).toEqual([1, 1])
    notify()
    expect([depCalls, readerCalls, connects, cleanups]).toEqual([2, 1, 1, 0])
    expect(_read(dep)!.subs).toHaveLength(1)
  } finally {
    detach()
    unsubscribe()
    notify()
  }
  expect(cleanups).toBe(1)
  expect(isConnected(dep)).toBe(false)
})

test.each([false, true])(
  'multi-pass read, observed=%s: settles the final outcome and releases its dependencies',
  (observed) => {
    let armed = false
    let calls = 0
    let connects = 0
    let cleanups = 0
    const passes: number[] = []
    const transientConnections: boolean[] = []
    const trigger = atom(0, 'recursiveTrigger')
    const transient = atom(3, 'transient')
    const finalDep = atom(7, 'finalDep').extend(
      withConnectHook(() => {
        connects++
        return () => {
          cleanups++
        }
      }),
    )
    const reader = computed(() => {
      calls++
      const value = trigger()
      if (!armed) return 0
      passes.push(value)
      if (value !== 0) {
        transient()
        trigger.set(0)
        return -1
      }
      transientConnections.push(isConnected(transient))
      return finalDep()
    }, 'recursiveReader')
    const source = atom(() => 1, 'recursiveSource')
    const outcomes: number[] = []
    const detach = observe(source, () => {
      outcomes.push(reader())
    })
    const unsubscribe = reader.subscribe(() => {})
    try {
      notify()
      expect(calls).toBe(1)
      armed = true
      trigger.set(1)
      if (observed) source()
      expect(calls).toBe(1)
      outcomes.push(reader())
      expect(outcomes).toEqual([7])
      expect(passes).toEqual([1, 0])
      expect(calls).toBe(3)
      // Both modes use the original per-pass dependency connections.
      expect(transientConnections).toEqual([true])
      expect(_read(finalDep)!.subs).toHaveLength(1)
      expect(isConnected(transient)).toBe(false)
      notify()
      expect([connects, cleanups]).toEqual([1, 0])
      expect(reader()).toBe(7)
      expect(calls).toBe(3)
    } finally {
      detach()
      unsubscribe()
      notify()
    }
    expect(cleanups).toBe(1)
    expect(isConnected(finalDep)).toBe(false)
    expect(_read(finalDep)!.subs).toHaveLength(0)
  },
)

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  'read-after-write to a dependency with another subscriber preserves lazy init, observed=%s, nested=%s',
  (observed, nested) => {
    let armed = false
    let calls = 0
    let initializations = 0
    const passes: number[][] = []
    const trigger = atom(0, 'writeTrigger')
    const dependency = atom(0, 'sharedDependency')
    const middle = nested
      ? computed(() => dependency(), 'sharedMiddle')
      : dependency
    const reader = computed(() => {
      calls++
      const n = trigger()
      if (!armed) return 0
      const value = middle()
      passes.push([n, value])
      if (n) {
        trigger.set(0)
        return -1
      }
      if (value === 0) dependency.set(1)
      return value
    }, 'writeReader')
    const source = atom(() => {
      initializations++
      return reader()
    }, 'writeSource')
    const observedValues: number[] = []
    const detach = observed
      ? observe(source, () => {
          observedValues.push(reader())
        })
      : () => {}
    const unsubscribeDependency = middle.subscribe(() => {})
    const notifications: number[] = []
    const unsubscribeReader = reader.subscribe((value) => {
      notifications.push(value)
    })
    try {
      notify()
      expect(calls).toBe(1)
      expect(_read(middle)!.subs).toHaveLength(1)
      armed = true
      trigger.set(1)
      // A later notification cannot repair an incorrect one-shot initializer.
      expect(source()).toBe(1)
      expect(initializations).toBe(1)
      expect(passes).toEqual([
        [1, 0],
        [0, 0],
        [0, 1],
      ])
      expect(calls).toBe(4)
      expect(observedValues).toEqual([])
      expect(_read(middle)!.subs).toHaveLength(2)
      notify()
      expect(notifications).toEqual([0, 1])
      expect(source()).toBe(1)
      expect(initializations).toBe(1)
    } finally {
      detach()
      unsubscribeReader()
      unsubscribeDependency()
      notify()
    }
    expect(isConnected(dependency)).toBe(false)
    expect(_read(dependency)!.subs).toHaveLength(0)
  },
)
