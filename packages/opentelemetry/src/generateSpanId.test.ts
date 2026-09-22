import { expect, test } from 'vitest'

import { generateSpanId } from './generateSpanId.ts'
import { HEX_SPAN_ID } from './test-helpers.ts'

test('matches the 16-character lowercase hex shape', () => {
  expect(generateSpanId()).toMatch(HEX_SPAN_ID)
})

test('has at least one non-zero byte (per OTel spec)', () => {
  const id = generateSpanId()
  expect(id).not.toBe('0000000000000000')
})

test('generates unique values', () => {
  const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()))
  expect(ids.size).toBe(100)
})
