import { expect, test } from 'vitest'

import { generateTraceId } from './generateTraceId.ts'
import { HEX_TRACE_ID } from './test-helpers.ts'

test('matches the 32-character lowercase hex shape', () => {
  expect(generateTraceId()).toMatch(HEX_TRACE_ID)
})

test('has at least one non-zero byte (per OTel spec)', () => {
  const id = generateTraceId()
  expect(id).not.toBe('00000000000000000000000000000000')
})

test('generates unique values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()))
  expect(ids.size).toBe(100)
})
