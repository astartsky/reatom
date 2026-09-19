import {
  action,
  atom,
  clearStack,
  computed,
  context,
  STACK,
} from '@reatom/core'
import { expect, test, vi } from 'vitest'

import type { SpanInput } from './buildSpan.ts'
import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { createWithOTel } from './withOTel.ts'

const targets = {
  action: (body: () => unknown, name: string) => action(body, name),
  computed: (body: () => unknown, name: string) => computed(body, name),
}

test.each([false, true])(
  'export diagnostics run after clearStack (throwing logger: %s)',
  async (throwing: boolean) => {
    const frames = STACK.slice()
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {
      if (throwing) throw new Error('diagnostic failure')
    })
    const otel = reatomOpentelemetry({
      endpoint: 'http://collector.invalid',
      serviceName: 'test',
      retry: { maxRetries: 0 },
      fetch: async () => new Response('', { status: 503 }),
    })
    try {
      const target = action(() => 42, 'work')
      clearStack()
      context.start(() => {
        expect(target()).toBe(42)
      })
      expect(STACK).toHaveLength(0)
      await otel.flush()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(warn).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      otel.dispose()
      warn.mockRestore()
      process.off('unhandledRejection', onUnhandled)
      STACK.splice(0, STACK.length, ...frames)
    }
  },
)

for (const [kind, make] of Object.entries(targets)) {
  test(`${kind}: returning a revoked Proxy preserves identity`, () => {
    const { proxy, revoke } = Proxy.revocable({}, {})
    revoke()
    const raw = make(() => proxy, 'raw')
    const traced = make(() => proxy, 'traced').extend(
      createWithOTel({ isActive: () => true, queueSpan() {} })(),
    )
    context.start(() => {
      expect(raw() === proxy).toBe(true)
      expect(traced() === proxy).toBe(true)
    })
  })

  test(`${kind}: inspecting a hostile error cannot replace the thrown value`, () => {
    const original = new Error('application failure')
    Object.defineProperty(original, 'constructor', {
      get() {
        throw new Error('observer failure')
      },
    })
    let calls = 0
    const traced = make(() => {
      calls++
      throw original
    }, 'traced').extend(
      createWithOTel({ isActive: () => true, queueSpan() {} })(),
    )
    context.start(() => {
      let caught: unknown
      try {
        traced()
      } catch (error) {
        caught = error
      }
      expect(caught === original).toBe(true)
      expect(calls).toBe(1)
    })
  })

  test(`${kind}: a throwing sink cannot change a successful application result`, () => {
    const result = { value: 42 }
    const sink = vi.fn(() => {
      throw new Error('sink failure')
    })
    let calls = 0
    const traced = make(() => {
      calls++
      return result
    }, 'traced').extend(
      createWithOTel({ isActive: () => true, queueSpan: sink })(),
    )
    context.start(() => {
      expect(traced()).toBe(result)
      expect(calls).toBe(1)
      expect(sink).toHaveBeenCalledTimes(1)
    })
  })

  test(`${kind}: failure to generate IDs cannot prevent application execution`, () => {
    const value = { value: 42 }
    let calls = 0
    const traced = make(() => {
      calls++
      return value
    }, 'traced').extend(
      createWithOTel({ isActive: () => true, queueSpan() {} })(),
    )
    const random = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation(() => {
        throw new Error('unavailable random source')
      })
    try {
      context.start(() => {
        expect(traced()).toBe(value)
        expect(calls).toBe(1)
      })
    } finally {
      random.mockRestore()
    }
  })

  test(`${kind}: plain thenables are returned without invoking then`, async () => {
    const then = vi.fn()
    const value = { then }
    const sink = vi.fn()
    const traced = make(() => value, 'traced').extend(
      createWithOTel({ isActive: () => true, queueSpan: sink })(),
    )
    context.start(() => {
      expect(traced()).toBe(value)
    })
    await Promise.resolve()
    expect(then).not.toHaveBeenCalled()
    expect(sink).toHaveBeenCalledTimes(1)
  })

  for (const reject of [false, true]) {
    test(`${kind}: original Promise ${reject ? 'rejection' : 'fulfillment'} survives a throwing sink`, async () => {
      const value = reject ? new Error('application rejection') : { value: 42 }
      let finish!: (value: unknown) => void
      const original = new Promise<unknown>((resolve, fail) => {
        finish = reject ? fail : resolve
      })
      const outcome = original.then(
        (result) => ({ ok: true, value: result }),
        (error) => ({ ok: false, value: error }),
      )
      let observed!: () => void
      const observation = new Promise<void>((resolve) => {
        observed = resolve
      })
      const sink = vi.fn(() => {
        observed()
        throw new Error('sink failure')
      })
      const traced = make(() => original, 'traced').extend(
        createWithOTel({ isActive: () => true, queueSpan: sink })(),
      )
      context.start(() => {
        expect(traced()).toBe(original)
      })
      finish(value)
      const [settled] = await Promise.all([outcome, observation])
      expect(settled.ok).toBe(!reject)
      expect(settled.value).toBe(value)
      expect(sink).toHaveBeenCalledTimes(1)
    })
  }

  test(`${kind}: repeated Promise callbacks finish observation only once`, async () => {
    const original = Promise.resolve(42)
    Object.defineProperty(original, 'then', {
      value: (resolve: (value: number) => void) => {
        resolve(42)
        resolve(42)
        return Promise.resolve()
      },
    })
    const sink = vi.fn()
    const traced = make(() => original, 'traced').extend(
      createWithOTel({ isActive: () => true, queueSpan: sink })(),
    )
    context.start(() => {
      expect(traced()).toBe(original)
    })
    expect(await original).toBe(42)
    expect(sink).toHaveBeenCalledTimes(1)
  })
}

test('atom setter AbortError keeps thrown identity and emits exactly one error span', () => {
  const spans: SpanInput[] = []
  const traced = atom(0, 'abortingAtom').extend(
    createWithOTel({
      isActive: () => true,
      queueSpan: (span) => spans.push(span),
    })(),
  )
  context.start(() => {
    traced() // initialize outside the measured window
    spans.length = 0
    const aborted = new DOMException('Aborted', 'AbortError')
    let caught: unknown
    try {
      traced.set(() => {
        throw aborted
      })
    } catch (error) {
      caught = error
    }
    expect(caught === aborted).toBe(true)
  })
  expect(spans).toHaveLength(1)
  expect(spans[0]!.status?.code).toBe('error')
})

test('computed suspension Promise keeps thrown identity and emits zero spans', () => {
  const spans: SpanInput[] = []
  const sentinel = Promise.resolve('suspense')
  let calls = 0
  const traced = computed(() => {
    calls++
    throw sentinel
  }, 'suspendingComputed').extend(
    createWithOTel({
      isActive: () => true,
      queueSpan: (span) => spans.push(span),
    })(),
  )
  context.start(() => {
    let caught: unknown
    try {
      traced()
    } catch (error) {
      caught = error
    }
    expect(caught === sentinel).toBe(true)
    expect(calls).toBe(1)
  })
  expect(spans).toHaveLength(0)
})
