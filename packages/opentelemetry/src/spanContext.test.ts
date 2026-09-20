import { action, computed, context, STACK } from '@reatom/core'
import { expect, onTestFinished, test } from 'vitest'

import {
  createChildContext,
  createSpanContext,
  isOTelInternal,
  ROOT_BOUNDARY,
} from './spanContext.ts'

test('context pairs are immutable and slots belong to individual adapters', () => {
  const first = createSpanContext()
  const second = createSpanContext()
  onTestFinished(first.dispose)
  onTestFinished(second.dispose)
  const a = createChildContext()
  const b = createChildContext()
  context.start(() => {
    const inner = action(() => {
      expect(first.current()).toBe(a)
      expect(second.current()).toBeUndefined()
      second.write(b)
      expect(first.current()).toBe(a)
      expect(second.current()).toBe(b)
    }, 'inner')
    action(() => {
      first.write(a)
      inner()
      expect(first.current()).toBe(a)
      expect(second.current()).toBeUndefined()
    }, 'outer')()
    expect(first.current()).toBeUndefined()
    expect(second.current()).toBeUndefined()
  })
  expect(Object.isFrozen(a)).toBe(true)
  expect(Object.isFrozen(b)).toBe(true)
  expect(a.traceId).not.toBe(b.traceId)
})

test('explicit boundary stops parent lookup, then admitted descendants establish a fresh context', () => {
  const storage = createSpanContext()
  onTestFinished(storage.dispose)
  const outer = createChildContext()
  context.start(() => {
    const grandchild = action(() => storage.current(), 'grandchild')
    const child = action(() => {
      const parent = storage.read(STACK.length - 2)
      expect(parent).toBe(ROOT_BOUNDARY)
      const fresh = createChildContext(parent)
      storage.write(fresh)
      expect(fresh.traceId).not.toBe(outer.traceId)
      expect(grandchild()).toBe(fresh)
    }, 'child')
    const boundary = action(() => {
      storage.write(ROOT_BOUNDARY)
      expect(storage.current()).toBeUndefined()
      child()
      expect(storage.current()).toBeUndefined()
    }, 'boundary')
    action(() => {
      storage.write(outer)
      boundary()
      expect(storage.current()).toBe(outer)
    }, 'outer')()
    expect(storage.current()).toBeUndefined()
  })
})

test('cached data context is not an execution parent', () => {
  const storage = createSpanContext()
  onTestFinished(storage.dispose)
  const stale = createChildContext()
  let dataCalls = 0
  context.start(() => {
    const data = computed(() => {
      dataCalls++
      storage.write(stale)
      return 1
    }, 'cachedData')
    expect(data()).toBe(1)
    const child = action(() => storage.current(), 'child')
    const derived = computed(() => {
      data()
      expect(STACK.at(-1)!.pubs.some((frame) => frame?.atom === data)).toBe(
        true,
      )
      return child()
    }, 'derived')
    expect(derived()).toBeUndefined()
    expect(dataCalls).toBe(1)
  })
})

test.each([
  ['var#_reatomOtelContext#1.run', true],
  ['var#_reatomOtelContext#2.spawn', true],
  ['_reatomOtel#1', false],
  ['var#_reatomOtelContextual#1.run', false],
  ['_reatomOtelUser', false],
  ['application', false],
] as const)(
  'reserved runtime name %s is internal=%s',
  (name: string, expected: boolean) => {
    expect(isOTelInternal({ name })).toBe(expected)
  },
)

test('storage acquires once on first write and releases only its own consumer', () => {
  const baseline = context._continuationContextConsumers ?? 0
  const first = createSpanContext()
  const second = createSpanContext()
  const idle = createSpanContext()
  try {
    expect(context._continuationContextConsumers ?? 0).toBe(baseline)
    idle.dispose()
    idle.dispose()
    context.start(() => {
      first.write(createChildContext())
      first.write(createChildContext())
      second.write(createChildContext())
    })
    expect(context._continuationContextConsumers).toBe(baseline + 2)
    first.dispose()
    first.dispose()
    expect(context._continuationContextConsumers).toBe(baseline + 1)
    second.dispose()
    expect(context._continuationContextConsumers ?? 0).toBe(baseline)
  } finally {
    first.dispose()
    second.dispose()
    idle.dispose()
  }
})
