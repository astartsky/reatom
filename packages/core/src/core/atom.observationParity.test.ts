import { expect, test } from 'test'

import type { AtomMeta } from './'
import { withComputed, withConnectHook } from '../extensions'
import {
  _read,
  atom,
  computed,
  createAtom,
  isConnected,
  mock,
  notify,
  withMiddleware,
} from './'

type Observer =
  NonNullable<AtomMeta['_executionObservers']> extends Set<infer T> ? T : never

test('createAtom retains its optional-name arity', () => {
  expect(createAtom.length).toBe(1)
  expect(createAtom({ initState: 7 })()).toBe(7)
  expect(createAtom({ initState: 8 }, undefined)()).toBe(8)
})

test('observer-initiated writes retain read restrictions and ordinary error caching', () => {
  let dependencyCalls = 0
  let armed = false
  const dependency = atom(() => {
    dependencyCalls++
    return 7
  })
  const target = atom(0).extend(
    withComputed((previous) => (armed ? dependency() : previous)),
  )
  const source = atom(() => 1)
  const errors: unknown[] = []
  expect(target()).toBe(0)
  armed = true
  const observer: Observer = () => {
    try {
      target.set(9)
    } catch (error) {
      errors.push(error)
    }
  }
  ;(source.__reatom._executionObservers ??= new Set()).add(observer)
  try {
    expect(source()).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      message: 'Execution is not allowed during observation',
    })
    expect(dependencyCalls).toBe(0)
    let cachedError: unknown
    try {
      target()
    } catch (error) {
      cachedError = error
    }
    expect(cachedError).toBe(errors[0])
    expect(target.set(11)).toBe(7)
    expect(target()).toBe(7)
    expect(dependencyCalls).toBe(1)
  } finally {
    source.__reatom._executionObservers?.delete(observer)
  }
})

test.each([undefined, '', 'explicit'])(
  'createAtom preserves lazy name defaults and setup access order (%s)',
  (name: string | undefined) => {
    const events: string[] = []
    const body = () => {
      events.push('body')
      return 7
    }
    Object.defineProperty(body, 'name', {
      get: () => {
        events.push('name')
        return 'calculation'
      },
    })
    const target = createAtom(
      {
        get computed() {
          events.push('computed')
          return body
        },
        get initState() {
          events.push('init')
          return 0
        },
      },
      name,
    )
    const creation =
      name === undefined ? ['computed', 'name', 'computed'] : ['computed']
    expect(events).toEqual(creation)
    if (name === undefined) expect(target.name).toMatch(/^calculation#\d+$/)
    else expect(target.name).toBe(name)
    expect(target()).toBe(7)
    expect(events).toEqual([...creation, 'init', 'body'])
  },
)

test('observation preserves literal, initialized lazy, function state and cached error identity', () => {
  const object = {}
  const fn = () => {
    throw new Error('must not execute stored function')
  }
  const plain = atom<unknown>(object)
  const empty = atom(undefined)
  let calls = 0
  const initialized = atom(() => {
    calls++
    return object
  })
  const error = new Error('cached application error')
  const failed = atom(() => {
    calls++
    throw error
  })
  const source = atom(() => 1)
  const values: unknown[] = []
  let caught: unknown
  initialized()
  try {
    failed()
  } catch {}
  plain.set(() => fn)
  const unmock = mock(plain, () => 'mocked')
  unmock()
  const before = [_read(plain), _read(initialized), _read(failed)]
  const observer: Observer = () => {
    values.push(plain(), empty(), initialized())
    try {
      failed()
    } catch (error) {
      caught = error
    }
  }
  ;(source.__reatom._executionObservers ??= new Set()).add(observer)
  try {
    expect(source()).toBe(1)
    expect(values).toEqual([fn, undefined, object])
    expect(caught).toBe(error)
    expect(calls).toBe(2)
    expect(_read(empty)).toBeUndefined()
    expect([_read(plain), _read(initialized), _read(failed)]).toEqual(before)
  } finally {
    source.__reatom._executionObservers?.delete(observer)
  }
})

test('observation does not invoke a cold setup accessor', () => {
  let getterCalls = 0
  let refusals = 0
  const target = createAtom({
    get initState() {
      getterCalls++
      return 7
    },
  })
  const source = atom(() => 1)
  const observer: Observer = () => {
    try {
      target()
    } catch {
      refusals++
    }
  }
  ;(source.__reatom._executionObservers ??= new Set()).add(observer)
  try {
    expect(source()).toBe(1)
    expect(refusals).toBe(1)
    expect(getterCalls).toBe(0)
    expect(_read(target)).toBeUndefined()
    expect(target()).toBe(7)
    expect(getterCalls).toBe(1)
  } finally {
    source.__reatom._executionObservers?.delete(observer)
  }
})

test('observation does not inspect a user-supplied setup Proxy', () => {
  let inspections = 0
  let reads = 0
  let refusals = 0
  const setup = new Proxy(
    { initState: 7 },
    {
      get(target, key, receiver) {
        if (key === 'initState') reads++
        return Reflect.get(target, key, receiver)
      },
      getOwnPropertyDescriptor(target, key) {
        inspections++
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    },
  )
  const target = createAtom(setup)
  const source = atom(() => 1)
  const observer: Observer = () => {
    try {
      target()
    } catch {
      refusals++
    }
  }
  ;(source.__reatom._executionObservers ??= new Set()).add(observer)
  try {
    expect(inspections).toBe(0)
    expect(source()).toBe(1)
    expect(inspections).toBe(0)
    expect(reads).toBe(0)
    expect(refusals).toBe(1)
    expect(_read(target)).toBeUndefined()
    expect(target()).toBe(7)
    expect(inspections).toBe(0)
    expect(reads).toBe(1)
  } finally {
    source.__reatom._executionObservers?.delete(observer)
  }
})

test.each(['computed', 'subscribed', 'late-transform'] as const)(
  'observation refuses derived reads before body or validation (%s)',
  (mode) => {
    let calls = 0
    let refusals = 0
    const input = atom(1)
    const body = () => {
      calls++
      return input()
    }
    const target = mode === 'late-transform' ? atom(0) : computed(body)
    if (mode === 'late-transform') target.extend(withComputed(body))
    const unsubscribe =
      mode === 'subscribed' ? target.subscribe(() => {}) : () => {}
    const before = calls
    const source = atom(() => 1)
    const observer: Observer = () => {
      try {
        target()
      } catch {
        refusals++
      }
    }
    ;(source.__reatom._executionObservers ??= new Set()).add(observer)
    try {
      expect(source()).toBe(1)
      expect(refusals).toBe(1)
      expect(calls).toBe(before)
      expect(target()).toBe(1)
      expect(calls).toBe(1)
      input.set(2)
      expect(target()).toBe(2)
      expect(calls).toBe(2)
    } finally {
      source.__reatom._executionObservers?.delete(observer)
      unsubscribe()
      notify()
    }
  },
)

test.each(['begin', 'end'] as const)(
  'observation reads cold literal data without starting its lifecycle (%s)',
  (phase) => {
    let connects = 0
    const telemetry = atom(7).extend(
      withConnectHook(() => {
        connects++
      }),
    )
    const source = atom(() => 1)
    const readings: number[] = []
    const read = () => {
      readings.push(telemetry())
    }
    const observer: Observer = () => {
      if (phase === 'begin') read()
      return phase === 'end' ? read : undefined
    }
    ;(source.__reatom._executionObservers ??= new Set()).add(observer)
    try {
      expect(_read(telemetry)).toBeUndefined()
      expect(source()).toBe(1)
      expect(readings).toEqual([7])
      expect(_read(telemetry)).toBeUndefined()
      notify()
      expect(connects).toBe(0)
      expect(telemetry()).toBe(7)
    } finally {
      source.__reatom._executionObservers?.delete(observer)
    }
  },
)

test.each(['begin', 'end'] as const)(
  'observation refuses read middleware before any application code (%s)',
  (phase) => {
    let calls = 0
    let refusals = 0
    const telemetry = atom(7).extend(
      withMiddleware(
        () => (next) => {
          calls++
          return next()
        },
        'read',
      ),
    )
    const source = atom(() => 1)
    const read = () => {
      try {
        telemetry()
      } catch {
        refusals++
      }
    }
    const observer: Observer = () => {
      if (phase === 'begin') read()
      return phase === 'end' ? read : undefined
    }
    ;(source.__reatom._executionObservers ??= new Set()).add(observer)
    try {
      expect(source()).toBe(1)
      expect(refusals).toBe(1)
      expect(calls).toBe(0)
      expect(_read(telemetry)).toBeUndefined()
      expect(telemetry()).toBe(7)
      expect(calls).toBe(1)
    } finally {
      source.__reatom._executionObservers?.delete(observer)
    }
  },
)

test.each([false, true])(
  'observer reads do not initialize application state early (observed=%s)',
  (observed: boolean) => {
    let phase = 0
    const journal: string[] = []
    const lazy = atom(() => {
      journal.push(`lazy:${phase}`)
      return phase
    }, 'early.lazy')
    const source = atom(() => {
      journal.push('source')
      phase = 1
      return lazy()
    }, 'early.source')
    const observer: Observer = () => {
      lazy()
    }
    if (observed) {
      ;(source.__reatom._executionObservers ??= new Set()).add(observer)
    }
    try {
      expect(source()).toBe(1)
      expect(journal).toEqual(['source', 'lazy:1'])
      expect(lazy()).toBe(1)
      expect(source()).toBe(1)
      expect(journal).toEqual(['source', 'lazy:1'])
    } finally {
      source.__reatom._executionObservers?.delete(observer)
    }
  },
)

test.each([false, true])(
  'observer reads preserve connection-dependent application results (observed=%s)',
  (observed: boolean) => {
    let armed = false
    let initializations = 0
    const passes: number[] = []
    const trigger = atom(0, 'parity.trigger')
    const transient = atom(3, 'parity.transient')
    const reader = computed(() => {
      const value = trigger()
      if (!armed) return -1
      passes.push(value)
      if (value !== 0) {
        transient()
        trigger.set(0)
        return -1
      }
      return isConnected(transient) ? 1 : 0
    }, 'parity.reader')
    const source = atom(() => {
      initializations++
      return reader()
    }, 'parity.source')
    const observerResults: number[] = []
    const refusedPasses: number[][] = []
    const observer: Observer = () => {
      try {
        observerResults.push(reader())
      } catch {
        refusedPasses.push([...passes])
      }
    }
    if (observed) {
      ;(source.__reatom._executionObservers ??= new Set()).add(observer)
    }
    const unsubscribe = reader.subscribe(() => {})
    try {
      notify()
      armed = true
      trigger.set(1)
      // The initializer must see the same result before any later notify.
      expect(source()).toBe(1)
      expect(initializations).toBe(1)
      expect(passes).toEqual([1, 0])
      expect(observerResults).toEqual([])
      expect(refusedPasses).toEqual(observed ? [[]] : [])
      expect(reader()).toBe(1)
      expect(isConnected(transient)).toBe(false)
    } finally {
      source.__reatom._executionObservers?.delete(observer)
      unsubscribe()
      notify()
    }
    expect(isConnected(trigger)).toBe(false)
  },
)
