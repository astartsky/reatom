import { action, actionMiddleware, context, sleep, wrap } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import type { SpanInput } from './buildSpan.ts'
import {
  createTestWithOTel,
  HEX_SPAN_ID,
  HEX_TRACE_ID,
} from './test-helpers.ts'

const collectSpans = () => {
  const spans: SpanInput[] = []
  const queueSpan = vi.fn((span: SpanInput) => {
    spans.push(span)
  })
  return { spans, queueSpan }
}

test('async action instrumentation survives minified core middleware names', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })
  const originalName = actionMiddleware.name
  try {
    Object.defineProperty(actionMiddleware, 'name', { value: 'a' })
    const increment = action(
      async (value: number) => value + 1,
      'increment',
    ).extend(withOTel())

    expect(await context.start(() => increment(41))).toBe(42)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.attributes).toEqual({ params: '[41]', payload: '42' })
  } finally {
    Object.defineProperty(actionMiddleware, 'name', { value: originalName })
  }
})

test('sync action records a span with name, params, payload, and unset status', () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })

  const greet = action((name: string) => `hi ${name}`, 'greet').extend(
    withOTel(),
  )

  context.start(() => {
    expect(greet('alice')).toBe('hi alice')
  })

  expect(spans).toHaveLength(1)
  expect(spans[0]).toMatchObject({
    name: 'greet',
    attributes: {
      params: '["alice"]',
      payload: 'hi alice',
    },
  })
  // OTel API spec: STATUS_CODE_OK SHOULD only be set by the application,
  // never by instrumentation. Auto-instrumentation leaves status unset.
  expect(spans[0]!.status).toBeUndefined()
  expect(spans[0]!.traceId).toMatch(HEX_TRACE_ID)
  expect(spans[0]!.spanId).toMatch(HEX_SPAN_ID)
  expect(spans[0]!.parentSpanId).toBeUndefined()
  expect(spans[0]!.endTimeMs).toBeGreaterThanOrEqual(spans[0]!.startTimeMs)
})

test('respects kind option override', () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })

  const fetchUser = action(() => 1, 'fetchUser').extend(
    withOTel({ kind: 'client' }),
  )

  context.start(() => {
    fetchUser()
  })

  expect(spans[0]!.kind).toBe('client')
})

test('nested actions share traceId; inner span has parentSpanId pointing at the outer', () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })

  const inner = action(() => 'inner-result', 'inner').extend(withOTel())
  const outer = action(() => inner(), 'outer').extend(withOTel())

  context.start(() => {
    outer()
  })

  expect(spans).toHaveLength(2)
  // Inner span closes before outer's queueSpan runs, so it lands first.
  const [innerSpan, outerSpan] = spans
  expect(innerSpan!.traceId).toBe(outerSpan!.traceId)
  expect(innerSpan!.parentSpanId).toBe(outerSpan!.spanId)
  expect(outerSpan!.parentSpanId).toBeUndefined()
})

test('async action records span when the promise resolves with unset status', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })

  const fetchData = action(async () => {
    await wrap(sleep(0))
    return 'done'
  }, 'fetchData').extend(withOTel())

  await context.start(() => fetchData())

  expect(spans).toHaveLength(1)
  expect(spans[0]).toMatchObject({
    name: 'fetchData',
    attributes: { payload: 'done' },
  })
  expect(spans[0]!.status).toBeUndefined()
})

test('async action records span with error status when the promise rejects', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })

  const broken = action(async () => {
    throw new Error('boom')
  }, 'broken').extend(withOTel())

  await context.start(async () => {
    await expect(broken()).rejects.toThrow('boom')
  })

  expect(spans).toHaveLength(1)
  expect(spans[0]!.name).toBe('broken')
  expect(spans[0]!.status?.code).toBe('error')
  expect(spans[0]!.status?.message).toContain('boom')
})

test('synchronous throw in an action records error span and rethrows', () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })

  const broken = action((): number => {
    throw new Error('bad')
  }, 'broken').extend(withOTel())

  context.start(() => {
    expect(() => broken()).toThrow('bad')
  })

  expect(spans).toHaveLength(1)
  expect(spans[0]!.status).toEqual({
    code: 'error',
    message: expect.stringContaining('bad'),
  })
})

// Message and data-property stack capture require explicit opt-in. Native
// lazy stack accessors must not be evaluated by descriptor-only observation.
test('async action rejection emits an `exception` event per OTel semconv', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })
  const failure = new TypeError('boom')
  Object.defineProperty(failure, 'stack', {
    value: 'captured-stack: boom at async-action',
    configurable: true,
  })

  const broken = action(async () => {
    throw failure
  }, 'broken').extend(withOTel())

  await context.start(async () => {
    await expect(broken()).rejects.toBe(failure)
  })

  expect(spans).toHaveLength(1)
  expect(spans[0]!.events).toHaveLength(1)
  const event = spans[0]!.events![0]!
  expect(event.name).toBe('exception')
  expect(event.attributes!['exception.type']).toBe('TypeError')
  expect(event.attributes!['exception.message']).toBe('boom')
  expect(event.attributes!['exception.stacktrace']).toBe(
    'captured-stack: boom at async-action',
  )
  expect(Object.hasOwn(event.attributes!, 'exception.escaped')).toBe(false)
  expect(event.timeMs).toBeGreaterThanOrEqual(spans[0]!.startTimeMs)
  expect(event.timeMs).toBeLessThanOrEqual(spans[0]!.endTimeMs)
})

test.each([undefined, {}])(
  'sync action throw emits an `exception` event with captureValues=%j',
  (
    captureValues: Parameters<typeof createTestWithOTel>[0]['captureValues'],
  ) => {
    const { spans, queueSpan } = collectSpans()
    const withOTel = createTestWithOTel({
      queueSpan,
      isActive: () => true,
      captureValues,
    })
    const failure = new RangeError('out')

    const broken = action((): number => {
      throw failure
    }, 'broken').extend(withOTel())

    let caught: unknown
    context.start(() => {
      try {
        broken()
      } catch (error) {
        caught = error
      }
    })

    expect(caught).toBe(failure)
    expect(spans).toHaveLength(1)
    const event = spans[0]!.events![0]!
    expect(event.name).toBe('exception')
    expect(event.attributes!['exception.type']).toBe('RangeError')
    if (captureValues) {
      expect(event.attributes!['exception.message']).toBe('out')
    } else {
      expect(event.attributes).toEqual({ 'exception.type': 'RangeError' })
      expect(spans[0]!.status).toEqual({ code: 'error' })
    }
    expect(Object.hasOwn(event.attributes!, 'exception.escaped')).toBe(false)
  },
)

test('non-Error throw still records exception event with sane defaults', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })

  const broken = action(async () => {
    throw 'string-throw'
  }, 'broken').extend(withOTel())

  await context.start(async () => {
    await expect(broken()).rejects.toBe('string-throw')
  })

  const event = spans[0]!.events![0]!
  expect(event.name).toBe('exception')
  expect(event.attributes!['exception.type']).toBe('Error')
  expect(event.attributes!['exception.message']).toBe('string-throw')
  // No stacktrace available for non-Error throws — skip attribute, don't lie.
  expect(event.attributes!).not.toHaveProperty('exception.stacktrace')
  expect(Object.hasOwn(event.attributes!, 'exception.escaped')).toBe(false)
})

test('a thrown Promise is control flow — [Suspension] marker, no exception event', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })
  const suspension = new Promise<never>(() => {})
  const suspending = action(() => {
    throw suspension
  }, 'suspending').extend(withOTel())

  let caught: unknown
  await context.start(async () => {
    try {
      await suspending()
    } catch (error) {
      caught = error
    }
  })

  expect(caught).toBe(suspension)
  expect(spans).toHaveLength(1)
  expect(spans[0]!.status).toBeUndefined()
  expect(spans[0]!.events ?? []).toEqual([])
  expect(spans[0]!.attributes).toEqual({ payload: '[Suspension]' })
})

test('sibling and repeated calls in one context.start get distinct root traces', () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })

  const a = action(() => 'a', 'a').extend(withOTel())
  const b = action(() => 'b', 'b').extend(withOTel())

  context.start(() => {
    a()
    b()
    a()
  })

  expect(spans).toHaveLength(3)
  expect(spans.map((span) => span.parentSpanId)).toEqual([
    undefined,
    undefined,
    undefined,
  ])
  expect(new Set(spans.map((span) => span.traceId)).size).toBe(3)
})

test('two concurrent async invocations of the same action get distinct root traces', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })

  const a = action(async () => {
    await wrap(sleep(0))
    return 'a'
  }, 'a').extend(withOTel())

  await context.start(async () => {
    await Promise.all([a(), a()])
  })

  expect(spans).toHaveLength(2)
  expect(spans[0]!.traceId).not.toBe(spans[1]!.traceId)
  expect(spans[0]!.parentSpanId).toBeUndefined()
  expect(spans[1]!.parentSpanId).toBeUndefined()
})

test('an async action followed by a sync sibling does not adopt the async one as parent', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })

  const asyncA = action(async () => 'a', 'asyncA').extend(withOTel())
  const syncB = action(() => 'b', 'syncB').extend(withOTel())

  await context.start(async () => {
    const pending = asyncA()
    syncB()
    await pending
  })

  const a = spans.find((s) => s.name === 'asyncA')!
  const b = spans.find((s) => s.name === 'syncB')!
  expect(a.traceId).not.toBe(b.traceId)
  expect(b.parentSpanId).toBeUndefined()
})

// OTel mandate: a tracer must never escalate. If queueSpan or serialize
// faults inside a `.then` callback, the rejection must be swallowed —
// otherwise instrumentation can crash the host under
// `--unhandled-rejections=strict` or pollute monitoring.
test('thrown queueSpan inside an async action does not become an unhandled rejection', async () => {
  let unhandled = 0
  const onUnhandled = () => {
    unhandled++
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const queueSpan = vi.fn(() => {
      throw new Error('hostile sink')
    })
    const withOTel = createTestWithOTel({ queueSpan, isActive: () => true })

    const fetchData = action(async () => 'done', 'fetchData').extend(withOTel())

    await context.start(() => fetchData())
    // Let `.then` callback's microtask run.
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(queueSpan).toHaveBeenCalled()
    expect(unhandled).toBe(0)
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('bigint payloads stringify to decimal strings without crashing the action', async () => {
  const { spans, queueSpan } = collectSpans()
  const withOTel = createTestWithOTel({
    queueSpan,
    isActive: () => true,
    captureValues: {},
  })
  // JSON.stringify throws on bare bigints; the replacer must convert first.
  const counter = action(async () => 1n, 'counter').extend(withOTel())

  await context.start(() => counter())
  expect(spans[0]!.attributes).toEqual({ params: '[]', payload: '"1"' })
})
