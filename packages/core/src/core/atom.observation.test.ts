import { expect, test, vi } from 'test'

import { withComputed, withConnectHook } from '../extensions'
import {
  action,
  type Atom,
  type AtomLike,
  type AtomMeta,
  atom,
  computed,
  isComputed,
  notify,
  top,
  withMiddleware,
} from './'

type Observer =
  NonNullable<AtomMeta['_executionObservers']> extends Set<infer T> ? T : never
type Event = Parameters<Observer>[0]
type Outcome = Parameters<Exclude<ReturnType<Observer>, void>>[0]

const observe = (target: AtomLike, observer: Observer) => {
  const observers = (target.__reatom._executionObservers ??= new Set())
  observers.add(observer)
  return () => observers.delete(observer)
}

test('lazy initialization encloses children without observing constant init or cached reads', () => {
  const order: string[] = []
  const events: Event[] = []
  const outcomes: Outcome[] = []
  let observedFrameIsTop = false
  let seenSentinel: unknown
  const child = action(() => order.push('child'), 'child')
  const value = {}
  const lazy = atom(() => {
    order.push('body')
    // The observer's begin-phase slot must be visible on the executing frame.
    seenSentinel = top()['var#observationSentinel']
    child()
    return value
  }, 'lazy')
  const pipeline = lazy.__reatom.pipeline
  observe(lazy, (event) => {
    events.push(event)
    observedFrameIsTop = event.frame === top()
    event.frame['var#observationSentinel'] = 'obs-sentinel'
    order.push(event.kind)
    return (outcome) => {
      outcomes.push(outcome)
      order.push('end')
    }
  })
  const constant = atom(1, 'constant')
  observe(constant, (event) => {
    events.push(event)
  })
  expect(order).toEqual([])
  expect(lazy.__reatom.pipeline).toBe(pipeline)
  expect(constant()).toBe(1)
  expect(lazy()).toBe(value)
  expect(lazy()).toBe(value)
  expect(events.map((event) => event.kind)).toEqual(['init'])
  expect(events[0]!.frame.atom).toBe(lazy)
  expect(order).toEqual(['init', 'body', 'child', 'end'])
  expect(outcomes).toEqual([{ ok: true, value }])
  // Assertions live outside the observer: it swallows throws.
  expect(observedFrameIsTop).toBe(true)
  expect(seenSentinel).toBe('obs-sentinel')
})

test('only actual compute executions are observed, including equal results and prior dependencies', () => {
  const source = atom(1, 'source')
  let calls = 0
  const derived = computed(() => {
    calls++
    source()
    return 0
  }, 'derived')
  const records: Array<{
    kind: string
    state: unknown
    prior: Array<[string, unknown]>
  }> = []
  observe(derived, (event) => {
    records.push({
      kind: event.kind,
      state: event.previousState,
      prior: event.previousPubs
        .slice(1)
        .map((pub) => [pub!.atom.name, pub!.state]),
    })
  })
  expect(derived()).toBe(0)
  expect(derived()).toBe(0)
  expect(calls).toBe(1)
  source.set(2)
  expect(derived()).toBe(0)
  expect(calls).toBe(2)
  const notifications: number[] = []
  const un = derived.subscribe((value) => notifications.push(value))
  try {
    source.set(3)
    notify()
    expect(calls).toBe(3)
    expect(derived()).toBe(0)
    expect(notifications).toEqual([0])
    expect(records.map((record) => record.kind)).toEqual([
      'compute',
      'compute',
      'compute',
    ])
    expect(records[0]!.prior).toEqual([])
    expect(records[1]).toEqual({
      kind: 'compute',
      state: 0,
      prior: [['source', 1]],
    })
    expect(records[2]).toEqual({
      kind: 'compute',
      state: 0,
      prior: [['source', 2]],
    })
  } finally {
    un()
  }
})

test.each(['begin', 'end'] as const)(
  'a read from the %s observer cannot reenter lazy initialization',
  (phase) => {
    let calls = 0
    let attempts = 0
    let completedReads = 0
    let otherBegins = 0
    let otherEnds = 0
    const value = atom(() => ++calls, 'lazy-reentry')
    const read = () => {
      if (attempts !== 0) return
      attempts++
      value()
      completedReads++
    }
    observe(value, ({ kind }) => {
      if (kind !== 'init') return
      if (phase === 'begin') read()
      return () => {
        if (phase === 'end') read()
      }
    })
    observe(value, ({ kind }) => {
      if (kind !== 'init') return
      otherBegins++
      return () => {
        otherEnds++
      }
    })

    expect(value()).toBe(1)
    expect(calls).toBe(1)
    expect(attempts).toBe(1)
    expect(completedReads).toBe(0)
    expect(otherBegins).toBe(1)
    expect(otherEnds).toBe(1)
    expect(value.__reatom.processing).toBe(0)
    expect(value.set(9)).toBe(9)
    expect(value()).toBe(9)
    expect(calls).toBe(1)
    expect(value.__reatom.processing).toBe(0)
  },
)

test('nested init observers refuse early reads while the body initializes its children', () => {
  let outerCalls = 0
  let innerCalls = 0
  let nestedAttempt = false
  let outerAttempt = false
  const reads: number[] = []
  const inner = atom(() => ++innerCalls, 'inner-init')
  const outer = atom(() => ++outerCalls + inner(), 'outer-init')
  observe(inner, ({ kind }) => {
    if (kind === 'init' && !nestedAttempt) {
      nestedAttempt = true
      outer()
    }
  })
  observe(outer, ({ kind }) => {
    if (kind === 'init' && !outerAttempt) {
      outerAttempt = true
      reads.push(inner())
      reads.push(outer())
    }
  })

  expect(outer()).toBe(2)
  expect(reads).toEqual([])
  expect([nestedAttempt, outerAttempt]).toEqual([true, true])
  expect([outerCalls, innerCalls]).toEqual([1, 1])
  expect([outer.__reatom.processing, inner.__reatom.processing]).toEqual([0, 0])
  expect(outer.set(9)).toBe(9)
  expect(inner.set(8)).toBe(8)
  expect([outer(), inner()]).toEqual([9, 8])
})

test('the observer guard preserves bounded self-reads in the initializer body', () => {
  const run = (observed: boolean) => {
    let calls = 0
    const value: Atom<number> = atom(() => {
      calls++
      if (calls === 1) value()
      return calls
    }, `body-self-read.${observed}`)
    if (observed) observe(value, () => () => {})
    return { result: value(), calls, processing: value.__reatom.processing }
  }
  const raw = run(false)
  expect(raw.calls).toBe(2)
  expect(run(true)).toEqual(raw)
})

test('sets include same-value writes and enclose updater children without reclassifying a plain atom', () => {
  const value = atom(1, 'value')
  const order: string[] = []
  const records: Array<{
    kind: string
    before: unknown
    params: readonly unknown[]
  }> = []
  const ends: Array<{ state: unknown; value: unknown }> = []
  const child = action(() => {
    order.push('child')
  }, 'child')
  const updater = (state: number) => {
    order.push('updater')
    child()
    return state + 1
  }
  const pipeline = value.__reatom.pipeline
  observe(value, (event) => {
    records.push({
      kind: event.kind,
      before: event.previousState,
      params: event.params,
    })
    order.push(event.kind)
    return (outcome) => {
      order.push('end')
      ends.push({
        state: event.frame.state,
        value: outcome.ok ? outcome.value : undefined,
      })
    }
  })
  expect(value()).toBe(1)
  expect(value.set(updater)).toBe(2)
  expect(value.set(2)).toBe(2)
  expect(value()).toBe(2)
  expect(order).toEqual(['set', 'updater', 'child', 'end', 'set', 'end'])
  expect(records).toEqual([
    { kind: 'set', before: 1, params: [updater] },
    { kind: 'set', before: 2, params: [2] },
  ])
  expect(ends).toEqual([
    { state: 1, value: 2 },
    { state: 2, value: 2 },
  ])
  expect(value.__reatom.pipeline).toBe(pipeline)
  expect(value.__reatom.writable).toBe(true)
  expect(isComputed(value)).toBe(false)
})

test.each([false, true])(
  'undefined remains a write on direct and extended paths; extended=%s',
  (extended) => {
    const value = atom<number | undefined>(1, 'undefined-write')
    if (extended) {
      value.extend(
        withMiddleware(
          () =>
            (next, ...args) =>
              next(...args),
          'read',
        ),
      )
    }
    const params: Array<readonly unknown[]> = []
    observe(value, (event) => {
      params.push(event.params)
    })
    const update = (previous: number | undefined) =>
      previous === undefined ? 2 : 3

    expect(value.__reatom.pipeline !== null).toBe(extended)
    expect(value()).toBe(1)
    expect(value.set(undefined)).toBeUndefined()
    expect(value()).toBeUndefined()
    expect(value.set(update)).toBe(2)
    expect(value()).toBe(2)
    expect(params).toEqual([[undefined], [update]])
  },
)

test.each([false, true])(
  'observer reads do not become dependencies; throw=%s',
  (throws) => {
    const source = atom(1, 'source')
    const connect = vi.fn()
    const telemetry = atom(1, 'telemetry').extend(withConnectHook(connect))
    const rawBody = vi.fn(() => source() * 2)
    const observedBody = vi.fn(() => source() * 2)
    const raw = computed<number>(rawBody, 'raw')
    const traced = computed<number>(observedBody, 'traced')
    const phases: string[] = []
    const frames: AtomLike[] = []
    observe(traced, () => {
      telemetry()
      phases.push('throwing-begin')
      if (throws) throw new Error('begin')
    })
    observe(traced, () => {
      telemetry()
      frames.push(top().atom)
      phases.push('begin')
      return () => {
        telemetry()
        phases.push('end')
        if (throws) throw new Error('end')
      }
    })
    const rawValues: number[] = [],
      observedValues: number[] = []
    const offRaw = raw.subscribe((value) => rawValues.push(value))
    const offTraced = traced.subscribe((value) => observedValues.push(value))
    try {
      telemetry.set(2)
      notify()
      expect(rawBody).toHaveBeenCalledTimes(1)
      expect(observedBody).toHaveBeenCalledTimes(1)
      expect(connect.mock.calls).toHaveLength(0)
      source.set(2)
      notify()
      expect(rawBody).toHaveBeenCalledTimes(2)
      expect(observedBody).toHaveBeenCalledTimes(2)
      expect(rawValues).toEqual([2, 4])
      expect(observedValues).toEqual(rawValues)
      expect(frames).toEqual([traced, traced])
      expect(phases).toEqual([
        'throwing-begin',
        'begin',
        'end',
        'throwing-begin',
        'begin',
        'end',
      ])
      expect(traced.__reatom.linking).toBe(false)
    } finally {
      offRaw()
      offTraced()
    }
  },
)

test('execution participants are snapshotted, deduplicated and finalized in reverse order', () => {
  const order: string[] = []
  const target = computed(() => {
    order.push('body')
    return 1
  }, 'target')
  const third: Observer = () => {
    order.push('third')
    return () => {
      order.push('third-end')
    }
  }
  const second: Observer = () => {
    order.push('second')
    return () => {
      order.push('second-end')
      throw new Error('end')
    }
  }
  const first: Observer = () => {
    order.push('first')
    target.__reatom._executionObservers!.delete(second)
    target.__reatom._executionObservers!.add(third)
    return () => {
      order.push('first-end')
    }
  }
  observe(target, first)
  observe(target, first)
  observe(target, second)
  expect(target()).toBe(1)
  expect(order).toEqual(['first', 'second', 'body', 'second-end', 'first-end'])
  order.length = 0
  target.__reatom._executionObservers!.clear()
  const value = atom(1, 'value')
  const detach = observe(value, () => {
    order.push('unexpected')
  })
  detach()
  expect(value.set(2)).toBe(2)
  expect(order).toEqual([])
})

test.each(['init', 'compute', 'set'] as const)(
  '%s preserves original throws and Promise return without assimilation',
  (kind) => {
    for (const error of [
      new Error('error'),
      new DOMException('aborted', 'AbortError'),
      Promise.resolve('suspense'),
    ]) {
      let bodyCalls = 0
      const body = () => {
        bodyCalls++
        throw error
      }
      const target =
        kind === 'init'
          ? atom(body)
          : kind === 'compute'
            ? computed(body)
            : atom<unknown>(0)
      const outcomes: Outcome[] = []
      observe(target, () => (outcome) => {
        outcomes.push(outcome)
        throw new Error('end')
      })
      let caught: unknown
      try {
        kind === 'set' ? (target as Atom<unknown>).set(body) : target()
      } catch (value) {
        caught = value
      }
      expect(caught).toBe(error)
      expect(bodyCalls).toBe(1)
      expect(outcomes).toEqual([{ ok: false, error }])
    }
    const promise = Promise.resolve({ result: 1 })
    const then = vi.spyOn(promise, 'then')
    let bodyCalls = 0
    const body = () => {
      bodyCalls++
      return promise
    }
    const target =
      kind === 'init'
        ? atom(body)
        : kind === 'compute'
          ? computed(body)
          : atom<unknown>(0)
    const outcomes: Outcome[] = []
    observe(target, () => (outcome) => {
      outcomes.push(outcome)
    })
    const result =
      kind === 'set' ? (target as Atom<unknown>).set(body) : target()
    expect(result === promise).toBe(true)
    expect(then.mock.calls).toHaveLength(0)
    expect(bodyCalls).toBe(1)
    expect(outcomes).toEqual([{ ok: true, value: promise }])
    then.mockRestore()
  },
)

test.each([false, true])(
  'withComputed extension parity; attached after subscription=%s',
  (late) => {
    const source = atom(1, 'source')
    const scenario = (instrumented: boolean) => {
      const target = atom(0, instrumented ? 'traced' : 'raw')
      const transforms = vi.fn(() => source())
      const events: string[] = []
      if (instrumented)
        observe(target, (event) => {
          events.push(event.kind)
        })
      const notifications: number[] = []
      if (!late) target.extend(withComputed(transforms))
      const off = target.subscribe((value) => notifications.push(value))
      if (late) target.extend(withComputed(transforms))
      return { target, transforms, events, notifications, off }
    }
    const raw = scenario(false),
      traced = scenario(true)
    try {
      const compare = () => {
        expect(traced.target()).toBe(raw.target())
        expect(traced.transforms).toHaveBeenCalledTimes(
          raw.transforms.mock.calls.length,
        )
        expect(traced.notifications).toEqual(raw.notifications)
        expect(isComputed(traced.target)).toBe(isComputed(raw.target))
      }
      compare()
      raw.target.set(2)
      traced.target.set(2)
      notify()
      compare()
      source.set(3)
      notify()
      compare()
      expect(traced.events.filter((kind) => kind === 'compute')).toHaveLength(
        traced.transforms.mock.calls.length,
      )
      expect(traced.events.filter((kind) => kind === 'set')).toHaveLength(1)
    } finally {
      raw.off()
      traced.off()
    }
  },
)

test('self-mutation retains the recursion limit and balances each actual execution', () => {
  const run = (instrumented: boolean) => {
    const source = atom(1, 'source')
    let calls = 0
    const derived = computed(() => {
      calls++
      source.set(source() + 1)
      return source()
    }, 'derived')
    const begins: string[] = [],
      ends: string[] = []
    if (instrumented) {
      for (const target of [source, derived])
        observe(target, (event) => {
          begins.push(event.kind)
          return () => {
            ends.push(event.kind)
          }
        })
    }
    let error: unknown
    try {
      derived()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('Stuck in recursion')
    expect(calls).toBeGreaterThan(1)
    expect(derived.__reatom.linking).toBe(false)
    if (instrumented) {
      expect(begins.filter((kind) => kind === 'compute')).toHaveLength(calls)
      expect(begins.filter((kind) => kind === 'set')).toHaveLength(calls)
      expect(ends.filter((kind) => kind === 'compute')).toHaveLength(calls)
      expect(ends.filter((kind) => kind === 'set')).toHaveLength(calls)
    }
    return { calls, state: source(), message: (error as Error).message }
  }
  expect(run(true)).toEqual(run(false))
})

test('observing bidirectional computeds preserves cycle propagation', () => {
  const run = (instrumented: boolean) => {
    const left: Atom<number> = atom(0, 'left').extend(
      withComputed(() => right() / 2),
    )
    const right: Atom<number> = atom(0, 'right').extend(
      withComputed(() => left() * 2),
    )
    let begins = 0,
      ends = 0
    if (instrumented)
      for (const target of [left, right])
        observe(target, () => {
          begins++
          return () => {
            ends++
          }
        })
    const states = [left(), right()]
    left.set(3)
    states.push(left(), right())
    right.set(10)
    states.push(left(), right())
    expect(states).toEqual([0, 0, 3, 6, 5, 10])
    if (instrumented) {
      expect(begins).toBeGreaterThan(0)
      expect(ends).toBe(begins)
    }
    return states
  }
  expect(run(true)).toEqual(run(false))
})

test('observation preserves user function receivers and argument counts', () => {
  const run = (instrumented: boolean) => {
    const calls: Array<[string, boolean, number]> = []
    const source = atom(function (this: unknown) {
      calls.push(['init', this === top().state, arguments.length])
      return 1
    })
    const derived = computed(function (this: unknown) {
      calls.push(['compute', this === undefined, arguments.length])
      return source()
    })
    if (instrumented)
      for (const target of [source, derived]) observe(target, () => () => {})
    expect(derived()).toBe(1)
    source.set(function (this: unknown, value) {
      calls.push(['set', this === undefined, arguments.length])
      return value + 1
    })
    expect(source()).toBe(2)
    return calls
  }
  expect(run(true)).toEqual(run(false))
  expect(run(true)).toEqual([
    ['compute', true, 1],
    ['init', true, 0],
    ['set', true, 1],
  ])
})
