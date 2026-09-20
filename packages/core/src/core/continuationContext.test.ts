import { afterEach, beforeEach, expect, test } from 'test'

import { withAbort } from '../extensions'
import { abortVar, wrap } from '../methods'
import { action, bind, context, type Frame, top } from './'

type Snapshot = Readonly<Record<`var#${string}`, unknown>>
type IntegrationFrame = Frame & { _continuationContext?: Snapshot }
const first = 'var#continuationTestA'
const second = 'var#continuationTestB'

let previousConsumers: number | undefined
beforeEach(() => {
  previousConsumers = context._continuationContextConsumers
})
afterEach(() => {
  context._continuationContextConsumers = previousConsumers
})

// Integration opt-in is explicit; ordinary variables remain live on the frame.
const install = (frame: IntegrationFrame, snapshot: Snapshot) => {
  frame._continuationContext = Object.freeze(snapshot)
  context._continuationContextConsumers = 1
}

test('bind reads a supplied runner only once during registration', () => {
  const frame = top()
  const descriptor = Object.getOwnPropertyDescriptor(frame, 'run')!
  const original = frame.run
  let reads = 0
  const runner: Frame['run'] = function <Params extends any[], Value>(
    this: Frame,
    target: (...params: Params) => Value,
    ...params: Params
  ): Value {
    return original.call(this, target, ...params) as Value
  }
  try {
    Object.defineProperty(frame, 'run', {
      configurable: true,
      get() {
        reads++
        return runner
      },
    })
    const callback = bind((value: number) => value, frame)
    expect(reads).toBe(1)
    Object.defineProperty(frame, 'run', descriptor)
    expect(callback(7)).toBe(7)
    expect(reads).toBe(1)
  } finally {
    Object.defineProperty(frame, 'run', descriptor)
  }
})

test('bind retains a custom runner binding operation', () => {
  const frame = top()
  const original = frame.run
  const previous = frame._continuationContext
  let registrations = 0
  const target = (value: number) => {
    expect(top()._continuationContext?.[first]).toBe('captured')
    return value
  }
  const runner: Frame['run'] = function <Params extends any[], Value>(
    this: Frame,
    target: (...params: Params) => Value,
    ...params: Params
  ): Value {
    return original.call(this, target, ...params) as Value
  }
  Object.defineProperty(runner, 'bind', {
    value(receiver: Frame, callback: typeof target) {
      registrations++
      expect(receiver).toBe(frame)
      expect(callback).toBe(target)
      return original.bind(receiver, callback, 7)
    },
  })
  try {
    install(frame, { [first]: 'captured' })
    frame.run = runner
    const callback = bind(target, frame)
    frame.run = original
    install(frame, { [first]: 'later' })
    expect(registrations).toBe(1)
    expect(callback(3)).toBe(7)
    expect(frame._continuationContext?.[first]).toBe('later')
  } finally {
    frame.run = original
    frame._continuationContext = previous
  }
})

test.each(['plain', 'snapshot'] as const)(
  'custom bind runner receives the original callback (%s context)',
  (mode) => {
    const frame = top()
    const original = frame.run
    const previous = frame._continuationContext
    const target = (value: number) => ({
      value,
      frame: top(),
      record: top()._continuationContext,
    })
    const policies = new WeakMap<Function, number>([[target, 7]])
    const supplied: Function[] = []
    try {
      if (mode === 'snapshot') install(frame, { [first]: 'captured' })
      const captured = frame._continuationContext
      frame.run = function (this: Frame, callback: (...args: any[]) => any) {
        supplied.push(callback)
        return original.call(this, callback, policies.get(callback) ?? 0)
      } as Frame['run']
      const callback = bind(target, frame)
      frame.run = original
      if (mode === 'snapshot') install(frame, { [first]: 'later' })

      const result = callback(3)
      expect(result.value).toBe(7)
      expect(supplied).toEqual([target])
      expect(result.frame).toBe(frame)
      expect(result.record).toBe(captured)
      expect(frame._continuationContext?.[first]).toBe(
        mode === 'snapshot' ? 'later' : undefined,
      )
    } finally {
      frame.run = original
      frame._continuationContext = previous
    }
  },
)

test('continuations registered before the first integration retain absence after activation', async () => {
  expect(context._continuationContextConsumers).toBeUndefined()
  const frame = top()
  const read = () => ({ frame: top(), record: top()._continuationContext })
  const callbacks = [bind(read), wrap(read)]
  // Until opt-in there is no snapshot installation at all.
  for (const callback of callbacks)
    expect(callback()).toEqual({ frame, record: undefined })
  const gate = Promise.withResolvers<void>()
  const pending = (async () => {
    await wrap(gate.promise)
    return read()
  })()
  install(frame, { [first]: 'later' })
  try {
    action(() => {
      install(top(), { [first]: 'different caller' })
      for (const callback of callbacks) {
        const result = callback()
        expect(result.frame).toBe(frame)
        expect(result.record).toEqual({})
      }
      gate.resolve()
    })()
    const result = await pending
    expect(result.frame).toBe(frame)
    expect(result.record).toEqual({})
    expect(frame._continuationContext?.[first]).toBe('later')
  } finally {
    gate.resolve()
    await pending
  }
})

for (const [name, preserve] of [
  ['bind', bind],
  ['wrap', wrap],
] as const) {
  test(`${name} captures the effective record through an uninstrumented frame`, () => {
    const outer = Object.freeze({ [first]: 'registration' })
    install(top(), outer)
    const relay = action(() => preserve(() => top()._continuationContext))
    const callback = relay()
    install(top(), { [first]: 'later', [second]: 'not registered' })
    expect(callback()).toBe(outer)
    expect(top()._continuationContext?.[first]).toBe('later')
  })

  test(`${name} respects the supplied frame and its registration ancestors`, () => {
    const supplied = context.start()
    install(top(), { [first]: 'unrelated caller' })
    const read = () => ({ frame: top(), record: top()._continuationContext })
    const outside = preserve(read, supplied)
    const sameStoreFrame = action(top)()
    const sameStore = preserve(read, sameStoreFrame)
    const inside = context.start(() => preserve(read))
    const result = outside()
    expect(result.frame).toBe(supplied)
    expect(result.record).toEqual({})
    expect(sameStore().record).toEqual({})
    expect(inside().record).toBe(top()._continuationContext)
    expect(top()._continuationContext?.[first]).toBe('unrelated caller')
  })

  test(`${name} captures integration slots without copying the frame or user variables`, () => {
    const frame: IntegrationFrame = top()
    const { pubs, subs, root, state } = frame
    const original = { original: true }
    install(frame, { [first]: original })
    frame['var#user'] = 'before'
    const callback = preserve(() => {
      expect(top()).toBe(frame)
      expect(top().pubs).toBe(pubs)
      expect(top().subs).toBe(subs)
      expect(top().root).toBe(root)
      expect(top().state).toBe(state)
      expect(top()['var#user']).toBe('after')
      return top()._continuationContext?.[first]
    })
    install(frame, { [first]: 'later', [second]: 'new integration' })
    frame['var#user'] = 'after'
    const current = frame._continuationContext
    expect(callback()).toBe(original)
    expect(frame._continuationContext?.[first]).toBe('later')
    expect(frame._continuationContext?.[second]).toBe('new integration')
    expect(frame._continuationContext).toBe(current)
  })

  test(`${name} captures absence and restores subsequently registered keys`, () => {
    const frame: IntegrationFrame = top()
    const callback = preserve(() => ({
      value: top()._continuationContext?.[first],
      own: Object.hasOwn(top()._continuationContext ?? {}, first),
    }))
    install(frame, { [first]: 'registered later' })
    expect(callback()).toEqual({ value: undefined, own: false })
    expect(frame._continuationContext?.[first]).toBe('registered later')
  })

  test(`${name} nests independent snapshots and restores after a throw`, () => {
    const frame: IntegrationFrame = top()
    const error = { error: true }
    install(frame, { [first]: 'outer A', [second]: 'outer B' })
    const outer = preserve(() => {
      const before = [
        frame._continuationContext?.[first],
        frame._continuationContext?.[second],
      ]
      inner()
      return [
        before,
        frame._continuationContext?.[first],
        frame._continuationContext?.[second],
      ]
    })
    install(frame, { [first]: 'inner A' })
    const inner = preserve(() => {
      expect([
        frame._continuationContext?.[first],
        frame._continuationContext?.[second],
      ]).toEqual(['inner A', undefined])
    })
    const throwing = preserve(() => {
      throw error
    })
    install(frame, { [first]: 'live A', [second]: 'live B' })
    const current = frame._continuationContext
    expect(outer()).toEqual([['outer A', 'outer B'], 'outer A', 'outer B'])
    let caught: unknown
    try {
      throwing()
    } catch (value) {
      caught = value
    }
    expect(caught).toBe(error)
    expect([
      frame._continuationContext?.[first],
      frame._continuationContext?.[second],
    ]).toEqual(['live A', 'live B'])
    expect(frame._continuationContext).toBe(current)
  })
}

test('bind retains a supplied frame runner while restoring captured slots', () => {
  const frame: IntegrationFrame = top()
  const original = frame.run
  let calls = 0
  frame.run = function (
    this: Frame,
    fn: (...params: any[]) => any,
    ...params: any[]
  ) {
    calls++
    return original.call(this, fn, ...params)
  } as Frame['run']
  try {
    install(frame, { [first]: 'captured' })
    const callback = bind(() => top()._continuationContext?.[first])
    frame.run = original
    install(frame, { [first]: 'live' })
    expect(callback()).toBe('captured')
    expect(calls).toBe(1)
    expect(frame._continuationContext?.[first]).toBe('live')
  } finally {
    frame.run = original
  }
})

test('function wrap uses the current runner and preserves arguments and thrown values', () => {
  const frame: IntegrationFrame = top()
  const original = frame.run
  install(frame, { [first]: 'captured' })
  const callback = wrap((value: unknown, fail: boolean) => {
    expect(top()).toBe(frame)
    expect(top()._continuationContext?.[first]).toBe('captured')
    if (fail) throw value
    return value
  })
  let calls = 0
  frame.run = function (
    this: Frame,
    fn: (...params: any[]) => any,
    ...params: any[]
  ) {
    calls++
    return original.call(this, fn, ...params)
  } as Frame['run']
  install(frame, { [first]: 'live' })
  try {
    const value = { value: true }
    expect(callback(value, false)).toBe(value)
    let thrown = false
    try {
      callback(undefined, true)
    } catch (error) {
      thrown = true
      expect(error).toBeUndefined()
    }
    expect(thrown).toBe(true)
    expect(calls).toBe(2)
    expect(frame._continuationContext?.[first]).toBe('live')
  } finally {
    frame.run = original
  }
})

test.each([false, true])(
  'Promise wrap captures both continuations (reject=%s)',
  async (reject: boolean) => {
    const frame: IntegrationFrame = top()
    const gates = [
      Promise.withResolvers<number>(),
      Promise.withResolvers<number>(),
    ]
    const seen: unknown[] = []
    const error = { rejected: true }
    const pending = gates.map((gate, index) => {
      install(frame, { [first]: index })
      return (async () => {
        try {
          const value = await wrap(gate.promise)
          expect(value).toBe(index)
        } catch (caught) {
          expect(reject).toBe(true)
          expect(caught).toBe(error)
        }
        expect(top()).toBe(frame)
        seen[index] = top()._continuationContext?.[first]
      })()
    })
    install(frame, { [first]: 'live' })
    try {
      for (const index of [1, 0]) {
        if (reject) gates[index]!.reject(error)
        else gates[index]!.resolve(index)
        await pending[index]
      }
      expect(seen).toEqual([0, 1])
      expect(frame._continuationContext?.[first]).toBe('live')
    } finally {
      gates.forEach((gate) => gate.resolve(0))
      await Promise.allSettled(pending)
    }
  },
)

test('Promise wrap installs its snapshot for inherited abort and restores the live frame', async () => {
  const gate = Promise.withResolvers<void>()
  let frame: IntegrationFrame
  let controller: ReturnType<typeof abortVar.require>
  let seen: unknown
  let caught: unknown
  let inner: Promise<void>
  const task = action(() => {
    frame = top()
    controller = abortVar.require()
    install(frame, { [first]: 'at registration' })
    return (inner = (async () => {
      try {
        await wrap(gate.promise)
      } catch (error) {
        caught = error
        seen = top()._continuationContext?.[first]
      }
    })())
  }).extend(withAbort('manual'))
  const pending = task()
  install(frame!, { [first]: 'later' })
  task.abort()
  try {
    await expect(pending).rejects.toBe(controller!.signal.reason)
    await inner!
    expect(caught).toBe(controller!.signal.reason)
    expect(seen).toBe('at registration')
    expect(frame!._continuationContext?.[first]).toBe('later')
  } finally {
    gate.resolve()
    await Promise.allSettled([pending, inner!])
  }
})

test.each(['plain', 'snapshot'] as const)(
  'custom bind runner applies the receiver and params (%s slots)',
  (mode) => {
    const frame: IntegrationFrame = top()
    const original = frame.run
    const receiver = { value: 7 }
    let seenThis: unknown
    let seenArgs: unknown[] = []
    let seenSlot: unknown
    const previous = frame[first]
    const own = Object.hasOwn(frame, first)
    const snapshot = frame._continuationContext

    try {
      if (mode === 'snapshot') install(frame, { [first]: 'captured' })
      // The runner is captured at registration, including its receiver policy.
      frame.run = function (
        this: Frame,
        fn: (...params: any[]) => any,
        ...params: any[]
      ) {
        return original.call(this, () => fn.apply(receiver, params))
      } as Frame['run']
      const callback = bind(function (
        this: { value: number } | undefined,
        a: number,
        b: number,
      ) {
        seenThis = this
        seenArgs = [a, b]
        seenSlot =
          mode === 'snapshot'
            ? top()._continuationContext?.[first]
            : top()[first]
        return `${this?.value}-${a}-${b}`
      }, frame)
      frame.run = original
      frame[first] = 'live'
      if (mode === 'snapshot') install(frame, { [first]: 'live' })

      const result = callback(3, 4)

      expect(seenThis).toBe(receiver)
      expect(seenArgs).toEqual([3, 4])
      expect(result).toBe('7-3-4')
      expect(seenSlot).toBe(mode === 'snapshot' ? 'captured' : 'live')
      expect(frame[first]).toBe('live')
    } finally {
      frame.run = original
      frame._continuationContext = snapshot
      if (own) frame[first] = previous
      else delete frame[first]
    }
  },
)
