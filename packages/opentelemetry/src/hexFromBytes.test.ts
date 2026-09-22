import { expect, test } from 'vitest'

import { hexFromBytes } from './hexFromBytes.ts'

test('converts bytes to lowercase hex string', () => {
  expect(hexFromBytes(new Uint8Array([0, 255, 16]))).toBe('00ff10')
})

test('zero-pads single digit hex values', () => {
  expect(hexFromBytes(new Uint8Array([0, 1, 2, 3]))).toBe('00010203')
})

test('returns empty string for empty array', () => {
  expect(hexFromBytes(new Uint8Array([]))).toBe('')
})
