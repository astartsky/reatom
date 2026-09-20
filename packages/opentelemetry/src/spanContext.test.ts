import { expect, test } from 'vitest'

import {
  createChildContext,
  createSpanContext,
  ROOT_BOUNDARY,
} from './spanContext.ts'

test('context pairs are immutable and children share only their parent trace ID', () => {
  const parent = createChildContext()
  const child = createChildContext(parent)
  const sibling = createChildContext(parent)
  const root = createChildContext()

  for (const pair of [parent, child, sibling, root])
    expect(Object.isFrozen(pair)).toBe(true)
  expect(child.traceId).toBe(parent.traceId)
  expect(sibling.traceId).toBe(parent.traceId)
  expect(root.traceId).not.toBe(parent.traceId)
  expect(
    new Set([parent, child, sibling, root].map((pair) => pair.spanId)).size,
  ).toBe(4)
})

test('adapter storage and disposal are independent', () => {
  const first = createSpanContext()
  const second = createSpanContext()
  const a = createChildContext()
  const b = createChildContext()
  try {
    first.write(a)
    expect(first.current()).toBe(a)
    expect(second.current()).toBeUndefined()
    second.write(b)
    expect(first.current()).toBe(a)
    expect(second.current()).toBe(b)
    first.dispose()
    expect(first.current()).toBeUndefined()
    expect(second.current()).toBe(b)
  } finally {
    first.dispose()
    second.dispose()
  }
})

test('save and restore preserve an explicit boundary, parent and initial absence', () => {
  const storage = createSpanContext()
  const outer = createChildContext()
  try {
    const restoreAbsent = storage.save()
    storage.write(outer)
    const restoreOuter = storage.save()
    storage.write(ROOT_BOUNDARY)
    expect(storage.read()).toBe(ROOT_BOUNDARY)
    expect(storage.current()).toBeUndefined()
    const restoreBoundary = storage.save()
    const fresh = createChildContext(storage.read())
    expect(fresh.traceId).not.toBe(outer.traceId)
    storage.write(fresh)
    expect(storage.current()).toBe(fresh)
    restoreBoundary()
    expect(storage.read()).toBe(ROOT_BOUNDARY)
    expect(storage.current()).toBeUndefined()
    restoreOuter()
    expect(storage.current()).toBe(outer)
    restoreAbsent()
    expect(storage.read()).toBeUndefined()
    expect(storage.current()).toBeUndefined()
  } finally {
    storage.dispose()
  }
})

test.each([false, true])(
  'disposal prevents writes and saved-context restoration (previously active=%s)',
  (active: boolean) => {
    const storage = createSpanContext()
    try {
      if (active) storage.write(createChildContext())
      const restore = storage.save()
      storage.dispose()
      expect(storage.read()).toBeUndefined()
      restore()
      expect(storage.read()).toBeUndefined()
      storage.write(createChildContext())
      expect(storage.current()).toBeUndefined()
      storage.write(ROOT_BOUNDARY)
      expect(storage.read()).toBeUndefined()
      storage.dispose()
      restore()
      expect(storage.current()).toBeUndefined()
    } finally {
      storage.dispose()
    }
  },
)
