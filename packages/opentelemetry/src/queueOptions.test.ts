import { describe, expect, test } from 'vitest'

import { resolveQueueOptions } from './queueOptions.ts'

const DEFAULTS = {
  batchInterval: 3000,
  maxBatchSize: 100,
  maxQueueSize: 1000,
  exportTimeoutMs: 30000,
}

describe('resolveQueueOptions', () => {
  test('fills every option with its documented default', () => {
    expect(resolveQueueOptions({})).toEqual(DEFAULTS)
    expect(resolveQueueOptions()).toEqual(DEFAULTS)
  })

  test('explicit valid overrides win per-option, others keep defaults', () => {
    expect(
      resolveQueueOptions({ maxBatchSize: 5, exportTimeoutMs: 1500 }),
    ).toEqual({
      ...DEFAULTS,
      maxBatchSize: 5,
      exportTimeoutMs: 1500,
    })
    expect(resolveQueueOptions({ batchInterval: 0.5 })).toEqual({
      ...DEFAULTS,
      batchInterval: 0.5,
    })
  })
  test('maxBatchSize above maxQueueSize is valid (no cross-limit rule)', () => {
    expect(
      resolveQueueOptions({ maxBatchSize: 5000, maxQueueSize: 10 }),
    ).toEqual({ ...DEFAULTS, maxBatchSize: 5000, maxQueueSize: 10 })
  })

  test('fractional positive timer durations are allowed up to the native timer cap', () => {
    expect(
      resolveQueueOptions({ exportTimeoutMs: 2147483647 }).exportTimeoutMs,
    ).toBe(2147483647)
    expect(resolveQueueOptions({ batchInterval: 2999.5 }).batchInterval).toBe(
      2999.5,
    )
  })

  test.each([
    ['maxBatchSize', 0],
    ['maxBatchSize', -1],
    ['maxBatchSize', Number.NaN],
    ['maxBatchSize', Number.POSITIVE_INFINITY],
    ['maxBatchSize', Number.NEGATIVE_INFINITY],
    ['maxBatchSize', 1.5],
    ['maxBatchSize', 2 ** 53],
    ['maxBatchSize', '100'],
    ['maxBatchSize', null],
    ['maxBatchSize', true],
    ['maxBatchSize', {}],
    ['maxBatchSize', [] as unknown[]],
    ['maxQueueSize', 0],
    ['maxQueueSize', -10],
    ['maxQueueSize', Number.NaN],
    ['maxQueueSize', Number.POSITIVE_INFINITY],
    ['maxQueueSize', 0.25],
    ['maxQueueSize', 2 ** 53],
    ['maxQueueSize', '10'],
    ['maxQueueSize', null],
  ])('rejects %s = %p', (option: string, value: unknown) => {
    expect(() => resolveQueueOptions({ [option]: value })).toThrow(RangeError)
    expect(() => resolveQueueOptions({ [option]: value })).toThrow(
      new RegExp(`\\b${option}\\b`),
    )
  })

  test.each([
    ['batchInterval', 0],
    ['batchInterval', -5],
    ['batchInterval', Number.NaN],
    ['batchInterval', Number.POSITIVE_INFINITY],
    ['batchInterval', Number.NEGATIVE_INFINITY],
    ['batchInterval', 2147483648],
    ['batchInterval', '3000'],
    ['batchInterval', null],
    ['batchInterval', false],
    ['exportTimeoutMs', 0],
    ['exportTimeoutMs', -1],
    ['exportTimeoutMs', Number.NaN],
    ['exportTimeoutMs', Number.POSITIVE_INFINITY],
    ['exportTimeoutMs', 2147483648],
    ['exportTimeoutMs', 1e10],
    ['exportTimeoutMs', '30000'],
    ['exportTimeoutMs', null],
  ])('rejects %s = %p', (option: string, value: unknown) => {
    expect(() => resolveQueueOptions({ [option]: value })).toThrow(RangeError)
    expect(() => resolveQueueOptions({ [option]: value })).toThrow(
      new RegExp(`\\b${option}\\b`),
    )
  })
})
