import { action, clearStack, computed, context, STACK } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import type { SpanInput } from './buildSpan.ts'
import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { createTestWithOTel } from './test-helpers.ts'

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

test(`action: inspecting a hostile error cannot replace the thrown value`, () => {
  const original = new Error('application failure')
  Object.defineProperty(original, 'constructor', {
    get() {
      throw new Error('observer failure')
    },
  })
  let calls = 0
  const traced = action(() => {
    calls++
    throw original
  }, 'traced').extend(
    createTestWithOTel({ isActive: () => true, queueSpan() {} })(),
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

test(`action: a throwing sink cannot change a successful application result`, () => {
  const result = { value: 42 }
  const sink = vi.fn(() => {
    throw new Error('sink failure')
  })
  let calls = 0
  const traced = action(() => {
    calls++
    return result
  }, 'traced').extend(
    createTestWithOTel({ isActive: () => true, queueSpan: sink })(),
  )
  context.start(() => {
    expect(traced()).toBe(result)
    expect(calls).toBe(1)
    expect(sink).toHaveBeenCalledTimes(1)
  })
})

test(`action: plain thenables are returned without invoking then`, async () => {
  const then = vi.fn()
  const value = { then }
  const sink = vi.fn()
  const traced = action(() => value, 'traced').extend(
    createTestWithOTel({ isActive: () => true, queueSpan: sink })(),
  )
  context.start(() => {
    expect(traced()).toBe(value)
  })
  await Promise.resolve()
  expect(then).not.toHaveBeenCalled()
  expect(sink).toHaveBeenCalledTimes(1)
})

for (const reject of [false, true]) {
  test(`action: original Promise ${reject ? 'rejection' : 'fulfillment'} survives a throwing sink`, async () => {
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
    const traced = action(() => original, 'traced').extend(
      createTestWithOTel({ isActive: () => true, queueSpan: sink })(),
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

test(`action: repeated Promise callbacks finish observation only once`, async () => {
  const original = Promise.resolve(42)
  Object.defineProperty(original, 'then', {
    value: (resolve: (value: number) => void) => {
      resolve(42)
      resolve(42)
      return Promise.resolve()
    },
  })
  const sink = vi.fn()
  const traced = action(() => original, 'traced').extend(
    createTestWithOTel({ isActive: () => true, queueSpan: sink })(),
  )
  context.start(() => {
    expect(traced()).toBe(original)
  })
  expect(await original).toBe(42)
  expect(sink).toHaveBeenCalledTimes(1)
})

test('computed suspension Promise keeps thrown identity and emits zero spans', () => {
  const spans: SpanInput[] = []
  const sentinel = Promise.resolve('suspense')
  let calls = 0
  const traced = computed(() => {
    calls++
    throw sentinel
  }, 'suspendingComputed').extend(
    createTestWithOTel({
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
