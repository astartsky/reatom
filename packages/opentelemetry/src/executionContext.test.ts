import {
  action,
  atom,
  bind,
  computed,
  context,
  isAbort,
  STACK,
  top,
  variable,
  withAbort,
  withComputed,
  withMiddleware,
  wrap,
} from '@reatom/core'
import { expect, test, vi } from 'vitest'

import {
  reatomOpentelemetry,
  type ReatomOpentelemetryInput,
} from './reatomOpentelemetry.ts'
import type { SpanContext } from './spanContext.ts'
import { parseSpans, type ParsedSpan } from './test-helpers.ts'

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

test.each([bind, wrap])(
  'last dispose stops continuation installation (%#)',
  (preserve: typeof bind) => {
    const { otel } = setup({ filter: () => false })
    try {
      context.start(() => {
        const frame = top()
        const read = () => ({
          frame: top(),
          record: top()._continuationContext,
        })
        const captured = otel.startTrace('first', () => preserve(read))
        expect(captured().record).toBeDefined()
        otel.startTrace('second', () => 2)
        otel.dispose()
        otel.dispose()
        expect(frame._continuationContext).toBeUndefined()
        expect(captured()).toEqual({ frame, record: undefined })
        expect(preserve(read)()).toEqual({ frame, record: undefined })
      })
    } finally {
      otel.dispose()
    }
  },
)

test('an idle adapter does not enable continuation handling', () => {
  const baseline = context._continuationContextConsumers ?? 0
  const { otel } = setup()
  try {
    expect(context._continuationContextConsumers ?? 0).toBe(baseline)
  } finally {
    otel.dispose()
  }
  expect(context._continuationContextConsumers ?? 0).toBe(baseline)
})

test.each([bind, wrap])(
  'disposing one adapter keeps another consumer active (%#)',
  (preserve: typeof bind) => {
    const a = setup({ filter: () => false }).otel
    const b = setup({ filter: () => false }).otel
    try {
      context.start(() => {
        let entered: SpanContext | undefined
        const callback = a.startTrace('a', () =>
          b.startTrace('b', () => {
            entered = b.getCurrentContext()
            return preserve(() => [
              a.getCurrentContext(),
              b.getCurrentContext(),
            ])
          }),
        )
        expect(entered).toBeDefined()
        a.dispose()
        a.dispose()
        b.startTrace('later', () => {
          const caller = b.getCurrentContext()
          expect(caller).not.toBe(entered)
          expect(callback()).toEqual([undefined, entered])
          expect(b.getCurrentContext()).toBe(caller)
        })
      })
    } finally {
      a.dispose()
      b.dispose()
    }
  },
)

test.each([bind, wrap])(
  'dispose inside a continuation still restores its caller (%#)',
  (preserve: typeof bind) => {
    const { otel } = setup({ filter: () => false })
    try {
      context.start(() => {
        const frame = top()
        let entered: typeof frame._continuationContext
        const callback = otel.startTrace('registration', () => {
          entered = frame._continuationContext
          return preserve(() => {
            expect(frame._continuationContext).toBe(entered)
            otel.dispose()
            expect(frame._continuationContext).toBe(entered)
            return 7
          })
        })
        expect(entered).toBeDefined()
        otel.startTrace('caller', () => {
          const caller = frame._continuationContext
          expect(caller).not.toBe(entered)
          expect(callback()).toBe(7)
          expect(frame._continuationContext).toBe(caller)
        })
        expect(frame._continuationContext).toBeUndefined()
      })
    } finally {
      otel.dispose()
    }
  },
)

test.each([bind, wrap])(
  'reactivation preserves old captured context and old absence (%#)',
  async (preserve: typeof bind) => {
    const a = setup({ filter: () => false }).otel
    let b: ReturnType<typeof setup> | undefined
    try {
      context.start(() => {
        const read = () => {
          expect(b!.otel.getCurrentContext()).toBeUndefined()
          return child()
        }
        const absent = preserve(read)
        const captured = a.startTrace('old', () => preserve(read))
        a.dispose()
        const dormant = preserve(read)
        b = setup()
        const child = action(() => 7, 'child')
        b.otel.startTrace('new', () => {
          const caller = b!.otel.getCurrentContext()
          expect(caller).toBeDefined()
          expect(absent()).toBe(7)
          expect(captured()).toBe(7)
          expect(dormant()).toBe(7)
          expect(b!.otel.getCurrentContext()).toBe(caller)
        })
      })
      await b!.otel.flush()
      const children = b!.spans.filter((s) => s.name === 'child')
      expect(children).toHaveLength(3)
      expect(b!.spans).toHaveLength(4)
      expect(children.every((s) => s.parentSpanId === undefined)).toBe(true)
      expect(new Set(b!.spans.map((s) => s.traceId)).size).toBe(4)
    } finally {
      a.dispose()
      b?.otel.dispose()
    }
  },
)

test('a pending wrapped Promise retains store and variables after final disposal', async () => {
  const value = atom(0)
  const scope = variable<string>()
  const { otel } = setup({ filter: () => false })
  const gate = Promise.withResolvers<void>()
  let pending: Promise<number> | undefined
  try {
    pending = context.start(() => {
      value.set(7)
      return scope.run('kept', () =>
        otel.startTrace('pending', async () => {
          const frame = top()
          await wrap(gate.promise)
          expect(top()).toBe(frame)
          expect(scope.get()).toBe('kept')
          expect(otel.getCurrentContext()).toBeUndefined()
          expect(top()._continuationContext).toBeUndefined()
          return value()
        }),
      )
    })
    otel.dispose()
    gate.resolve()
    expect(await pending).toBe(7)
    expect(context.start(value)).toBe(0)
  } finally {
    gate.resolve()
    await pending
    otel.dispose()
  }
})

test.each([bind, wrap])(
  'a dormant continuation can create the next adapter (%#)',
  async (preserve: typeof bind) => {
    const a = setup({ filter: () => false }).otel
    let b: ReturnType<typeof setup> | undefined
    try {
      context.start(() => {
        const callback = a.startTrace('old', () =>
          preserve(() => {
            b = setup()
            const child = action(() => 7, 'child')
            const absent = preserve(() => {
              expect(b!.otel.getCurrentContext()).toBeUndefined()
              return child()
            })
            return b.otel.startTrace('new', () => {
              const entered = b!.otel.getCurrentContext()
              const active = preserve(() => {
                expect(b!.otel.getCurrentContext()).toBe(entered)
                return child()
              })
              expect(absent()).toBe(7)
              expect(active()).toBe(7)
              return 14
            })
          }),
        )
        a.dispose()
        expect(callback()).toBe(14)
      })
      await b!.otel.flush()
      expect(b!.spans).toHaveLength(3)
      const root = b!.spans.find((s) => s.name === 'new')!
      const children = b!.spans.filter((s) => s.name === 'child')
      expect(children.map((s) => s.parentSpanId)).toEqual([
        undefined,
        root.spanId,
      ])
      expect(children[0]!.traceId).not.toBe(root.traceId)
      expect(children[1]!.traceId).toBe(root.traceId)
    } finally {
      a.dispose()
      b?.otel.dispose()
    }
  },
)

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

test('binding after a root captures the restored context, including absence', () => {
  const { otel, run } = setup()
  try {
    run(() => {
      otel.startTrace('finished', () => 1)
      const callback = bind(() => otel.getCurrentContext())
      otel.startTrace('later', () => {
        const before = otel.getCurrentContext()
        expect(before).toBeDefined()
        expect(callback()).toBeUndefined()
        expect(otel.getCurrentContext()).toBe(before)
      })
      expect(otel.getCurrentContext()).toBeUndefined()
    })
  } finally {
    otel.dispose()
  }
})

for (const [name, preserve] of [
  ['bind', bind],
  ['wrap', wrap],
] as const) {
  test.each([false, true])(
    `${name} preserves absent trace across distinct frames (action registration=%s)`,
    async (actionRegistration: boolean) => {
      // This action predates the adapter: no instrumentation installs a carrier.
      const register = action((create: () => () => number) => create())
      const { otel, spans, run } = setup()
      let captured: SpanContext | undefined
      let resumed: SpanContext | undefined
      let restored: SpanContext | undefined
      let later: SpanContext | undefined
      let registrationFrame: ReturnType<typeof top>
      let resumedFrame: ReturnType<typeof top>
      try {
        const resumedChild = action(() => 7, 'resumed-child')
        const ordinaryChild = action(() => 8, 'ordinary-child')
        run(() => {
          const registerCallback = () => {
            registrationFrame = top()
            captured = otel.getCurrentContext()
            return preserve(() => {
              resumedFrame = top()
              resumed = otel.getCurrentContext()
              return resumedChild()
            })
          }
          const callback = actionRegistration
            ? register(registerCallback)
            : registerCallback()
          const invoke = action(
            () =>
              otel.startTrace('later', () => {
                expect(top()).not.toBe(registrationFrame)
                later = otel.getCurrentContext()
                expect(ordinaryChild()).toBe(8)
                const result = callback()
                restored = otel.getCurrentContext()
                return result
              }),
            'invoker',
          )
          expect(invoke()).toBe(7)
        })
        expect(captured).toBeUndefined()
        expect(resumed).toBeUndefined()
        expect(resumedFrame!).toBe(registrationFrame!)
        expect(later).toBeDefined()
        expect(restored).toBe(later)
        await otel.flush()
        expectTree(spans, {
          invoker: null,
          later: null,
          'ordinary-child': 'later',
          'resumed-child': null,
        })
      } finally {
        otel.dispose()
      }
    },
  )

  test(`${name} retains the effective trace when registration starts a separate store`, async () => {
    const source = atom(0, 'store-source')
    const { otel, spans, run } = setup()
    let entered: SpanContext | undefined
    let resumed: SpanContext | undefined
    try {
      const child = action(() => source(), 'child')
      const callback = run(() =>
        otel.startTrace('registration', () => {
          source.set(9)
          return context.start(() => {
            expect(source()).toBe(0)
            entered = otel.getCurrentContext()
            return preserve(() => {
              resumed = otel.getCurrentContext()
              return child()
            })
          })
        }),
      )
      expect(entered).toBeDefined()
      expect(run(callback)).toBe(0)
      expect(resumed).toBe(entered)
      await otel.flush()
      expect(run(source)).toBe(9)
      expectTree(spans, { registration: null, child: 'registration' })
    } finally {
      otel.dispose()
    }
  })

  test(`${name} retains a trace inherited through a pre-existing action at registration`, async () => {
    const register = action((create: () => () => number) => create())
    const { otel, spans, run } = setup()
    let entered: SpanContext | undefined
    let resumed: SpanContext | undefined
    try {
      const child = action(() => 7, 'child')
      run(() => {
        const callback = otel.startTrace('registration', () =>
          register(() => {
            entered = otel.getCurrentContext()
            return preserve(() => {
              resumed = otel.getCurrentContext()
              return child()
            })
          }),
        )
        const invoke = action(
          () => otel.startTrace('later', callback),
          'invoker',
        )
        expect(invoke()).toBe(7)
      })
      expect(entered).toBeDefined()
      expect(resumed).toBe(entered)
      await otel.flush()
      expectTree(spans, {
        registration: null,
        invoker: null,
        later: null,
        child: 'registration',
      })
    } finally {
      otel.dispose()
    }
  })
}

for (const [name, preserve] of [
  ['bind', bind],
  ['wrap', wrap],
] as const) {
  test(`${name} preserves one adapter and absence of an adapter created later`, async () => {
    const relay = action((create: () => () => number) => create())
    const register = action((create: () => () => number) => relay(create))
    const a = setup()
    let b: ReturnType<typeof setup> | undefined
    let entered: SpanContext | undefined
    let resumed: Array<SpanContext | undefined> = []
    try {
      const callback = a.run(() =>
        a.otel.startTrace('registration', () =>
          register(() => {
            entered = a.otel.getCurrentContext()
            return preserve(() => {
              resumed = [
                a.otel.getCurrentContext(),
                b!.otel.getCurrentContext(),
              ]
              return child()
            })
          }),
        ),
      )
      b = setup()
      const child = action(() => 9, 'child')
      const invoke = action(
        () => b!.otel.startTrace('later', callback),
        'invoker',
      )
      expect(a.run(invoke)).toBe(9)
      expect(entered).toBeDefined()
      expect(resumed).toEqual([entered, undefined])
      await a.otel.flush()
      await b.otel.flush()
      expectTree(a.spans, {
        registration: null,
        invoker: null,
        child: 'registration',
      })
      expectTree(b.spans, { invoker: null, later: null, child: null })
    } finally {
      a.otel.dispose()
      b?.otel.dispose()
    }
  })

  test(`${name} captures the supplied frame, not an unrelated registration caller`, async () => {
    const { otel, spans, run } = setup()
    const supplied = context.start()
    let seen: SpanContext | undefined
    try {
      const child = action(() => 9, 'child')
      const callback = run(() =>
        otel.startTrace('registration', () =>
          preserve(() => {
            expect(top()).toBe(supplied)
            seen = otel.getCurrentContext()
            return child()
          }, supplied),
        ),
      )
      expect(run(() => otel.startTrace('later', callback))).toBe(9)
      expect(seen).toBeUndefined()
      await otel.flush()
      expectTree(spans, { registration: null, later: null, child: null })
    } finally {
      otel.dispose()
    }
  })
}

test('middleware after execution inherits the caller, not the completed span', async () => {
  const { otel, spans, run } = setup()
  let outer: SpanContext | undefined
  let afterExecution: SpanContext | undefined
  try {
    const inside = action(() => 4, 'inside')
    const after = action(() => 5, 'after')
    const derived = computed(() => inside(), 'derived').extend(
      withMiddleware(
        () =>
          (next, ...params) => {
            const value = next(...params)
            afterExecution = otel.getCurrentContext()
            after()
            return value
          },
        'read',
      ),
    )
    expect(
      run(() =>
        otel.startTrace('root', () => {
          outer = otel.getCurrentContext()
          return derived()
        }),
      ),
    ).toBe(4)
    expect(outer).toBeDefined()
    expect(afterExecution).toBe(outer)
    await otel.flush()
    expectTree(spans, {
      root: null,
      derived: 'root',
      inside: 'derived',
      after: 'root',
    })
  } finally {
    otel.dispose()
  }
})

test('nested async roots on one frame retain both adapters and restore the caller', async () => {
  const a = setup()
  const b = setup()
  const gate = Promise.withResolvers<void>()
  let promise: Promise<number>
  let entered: unknown[] = []
  let resumed: unknown[] = []
  const frame = a.run(top)
  try {
    const child = action(() => 42, 'child')
    const result = a.run(() =>
      a.otel.startTrace('a', () =>
        b.otel.startTrace('b', () => {
          expect(top()).toBe(frame)
          entered = [a.otel.getCurrentContext(), b.otel.getCurrentContext()]
          return (promise = (async () => {
            await wrap(gate.promise)
            expect(top()).toBe(frame)
            resumed = [a.otel.getCurrentContext(), b.otel.getCurrentContext()]
            return child()
          })())
        }),
      ),
    )
    expect(result).toBe(promise!)
    a.run(() => {
      expect(a.otel.getCurrentContext()).toBeUndefined()
      expect(b.otel.getCurrentContext()).toBeUndefined()
    })
    gate.resolve()
    expect(await result).toBe(42)
    expect(resumed).toEqual(entered)
    await a.otel.flush()
    await b.otel.flush()
    expectTree(a.spans, { a: null, child: 'a' })
    expectTree(b.spans, { b: null, child: 'b' })
    a.run(() => {
      expect(a.otel.getCurrentContext()).toBeUndefined()
      expect(b.otel.getCurrentContext()).toBeUndefined()
    })
  } finally {
    gate.resolve()
    await promise!?.catch(() => {})
    a.otel.dispose()
    b.otel.dispose()
  }
})

test('explicit roots separate outer trace, group siblings, restore context and preserve returns', async () => {
  const { otel, spans, run } = setup()
  const result = { result: 1 }
  const seen: SpanContext[] = []
  try {
    const a = action(() => 'a', 'a')
    const b = action(() => 'b', 'b')
    const c = action(() => 'c', 'c')
    const after = action(() => 'after', 'after')
    const outer = action(() => {
      const previous = otel.getCurrentContext()!
      expect(
        otel.startTrace('first', () => {
          seen.push(otel.getCurrentContext()!)
          a()
          b()
          return result
        }),
      ).toBe(result)
      expect(otel.getCurrentContext()).toBe(previous)
      otel.startTrace('second', () => {
        c()
      })
      expect(otel.getCurrentContext()).toBe(previous)
      after()
    }, 'outer')
    run(outer)
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

test('sequential roots through an untraced wrapped continuation do not inherit earlier spans', async () => {
  const { otel, spans, run } = setup({
    filter: (target) => target.name !== 'untraced',
  })
  try {
    const first = action(() => 1, 'first')
    const second = action(() => 2, 'second')
    const untraced = action(async () => {
      first()
      await wrap(Promise.resolve())
      expect(otel.getCurrentContext()).toBeUndefined()
      second()
    }, 'untraced')
    await run(untraced)
    await otel.flush()
    expectTree(spans, { first: null, second: null })
  } finally {
    otel.dispose()
  }
})

test('filtered actions, computed and lazy init carry their execution parent through await', async () => {
  const { otel, spans, run } = setup({
    filter: (target) => !target.name.startsWith('filtered'),
  })
  try {
    const leaf = action(() => 'value', 'leaf')
    const lazy = atom(() => leaf(), 'filteredLazy')
    const derived = computed(() => lazy(), 'filteredComputed')
    const sync = action(() => derived(), 'filteredSync')
    const asyncCarrier = action(async () => {
      await wrap(Promise.resolve())
      return sync()
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
  'cached data cannot parent a later computed (filtered=%s)',
  async (filtered: boolean) => {
    const { otel, spans, run } = setup({
      filter: (target) => !filtered || target.name !== 'derived',
    })
    try {
      let dataCalls = 0
      const data = computed(() => {
        dataCalls++
        return 7
      }, 'data')
      const seed = action(() => data(), 'seed')
      const child = action(() => 1, 'child')
      const derived = computed(() => {
        expect(data()).toBe(7)
        expect(STACK.at(-1)!.pubs.some((frame) => frame?.atom === data)).toBe(
          true,
        )
        return child()
      }, 'derived')
      run(seed)
      expect(run(derived)).toBe(1)
      expect(dataCalls).toBe(1)
      await otel.flush()
      expectTree(
        spans,
        filtered
          ? { seed: null, data: 'seed', child: null }
          : { seed: null, data: 'seed', derived: null, child: 'derived' },
      )
    } finally {
      otel.dispose()
    }
  },
)

test('concurrent wrapped roots and filtered continuations keep separate immutable contexts', async () => {
  const { otel, spans, run } = setup({
    filter: (target) => !target.name.startsWith('carrier'),
  })
  const left = Promise.withResolvers<void>()
  const right = Promise.withResolvers<void>()
  try {
    const a = action(() => 'a', 'a')
    const b = action(() => 'b', 'b')
    const carrierA = action(async () => {
      await wrap(left.promise)
      return a()
    }, 'carrierA')
    const carrierB = action(async () => {
      await wrap(right.promise)
      return b()
    }, 'carrierB')
    let originalA!: Promise<string>, originalB!: Promise<string>
    const promiseA = run(() =>
      otel.startTrace('left', () => (originalA = carrierA())),
    )
    const promiseB = run(() =>
      otel.startTrace('right', () => (originalB = carrierB())),
    )
    expect(promiseA).toBe(originalA)
    expect(promiseB).toBe(originalB)
    right.resolve()
    expect(await promiseB).toBe('b')
    left.resolve()
    expect(await promiseA).toBe('a')
    await otel.flush()
    expectTree(spans, { left: null, right: null, a: 'left', b: 'right' })
  } finally {
    left.resolve()
    right.resolve()
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
    try {
      const downstream = action(() => {
        writes++
        return state()
      }, 'downstream')
      const outer = action(
        () =>
          otel.startTrace('trace', async () => {
            expect(state()).toBe(7)
            expect(user.get()).toBe('current-user')
            state.set(8)
            await wrap(gate.promise)
            return downstream()
          }),
        'outer',
      ).extend(withAbort('manual'))
      const result = run(() => {
        state.set(7)
        return user.run('current-user', () => outer())
      })
      // Attach a rejection handler before abort so the test does not leak it.
      const settled = result.then(
        (value) => ({ value }),
        (error) => ({ error }),
      )
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
    try {
      const fill1 = action(() => 1, 'fill1'),
        fill2 = action(() => 2, 'fill2'),
        fill3 = action(() => 3, 'fill3')
      const grandchild = action(() => 1, 'grandchild')
      const child = action(() => grandchild(), 'child')
      const sibling = action(() => 2, 'sibling')
      const carrier = action(async () => {
        expect(otel.getCurrentContext()).toBe(
          explicit ? undefined : parentContext,
        )
        await wrap(gate.promise)
        expect(otel.getCurrentContext()).toBe(
          explicit ? undefined : parentContext,
        )
        child()
        sibling()
      }, 'carrier')
      const rejected = action(() => carrier(), 'rejected')
      const outer = action(() => {
        parentContext = otel.getCurrentContext()
        fill1()
        fill2()
        fill3()
        expect(otel.stats()).toMatchObject({ active: 1, queued: 3 })
        const before = ids.mock.calls.length
        const promise = explicit
          ? otel.startTrace('rejected', () => carrier())
          : rejected()
        expect(ids.mock.calls.length).toBe(before)
        return promise
      }, 'outer')
      const pending = run(outer)
      expect(otel.stats()).toMatchObject({
        active: 1,
        queued: 3,
        droppedByReason: { capacity: 1 },
      })
      await otel.flush()
      expect(otel.stats()).toMatchObject({ active: 1, queued: 0, inFlight: 0 })
      gate.resolve()
      await pending
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
      otel.dispose()
      ids.mockRestore()
    }
  },
)

test('two active adapters isolate slots and ignore each other’s private helpers before custom filters', async () => {
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

test('compute and set executions on one frame are siblings under their actual caller', async () => {
  const { otel, spans, run } = setup()
  try {
    const value = atom(0, 'value').extend(withComputed((state) => state + 1))
    run(value)
    await otel.flush()
    expectTree(spans, { value: null })
    spans.length = 0
    const writer = action(() => value.set(5), 'writer')
    expect(run(writer)).toBe(6)
    await otel.flush()
    expect(spans.map((span) => span.name).sort()).toEqual([
      'value',
      'value',
      'value',
      'writer',
    ])
    const parent = spans.find((span) => span.name === 'writer')!
    expect(parent.parentSpanId).toBeUndefined()
    for (const execution of spans.filter((span) => span.name === 'value')) {
      expect(execution.parentSpanId).toBe(parent.spanId)
      expect(execution.traceId).toBe(parent.traceId)
    }
  } finally {
    otel.dispose()
  }
})
