import { expect, test } from 'vitest'

import { msToNano } from './msToNano.ts'

test('converts 1000ms to a nanoseconds string (OTLP JSON encodes int64 as string)', () => {
  expect(msToNano(1000)).toBe('1000000000')
})

test('converts 0ms', () => {
  expect(msToNano(0)).toBe('0')
})

test('converts 1ms', () => {
  expect(msToNano(1)).toBe('1000000')
})

test('handles large timestamps', () => {
  const ms = 1704067200000
  expect(msToNano(ms)).toBe('1704067200000000000')
})

test('rounds fractional ms from performance.now() into nanoseconds', () => {
  expect(msToNano(1.5)).toBe('1500000')
  expect(msToNano(0.000001)).toBe('1')
})

test('preserves precision past Number.MAX_SAFE_INTEGER', () => {
  expect(msToNano(1761000000123)).toBe('1761000000123000000')
})
