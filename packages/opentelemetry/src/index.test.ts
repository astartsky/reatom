import { expect, test } from 'vitest'

import * as pkg from './index.ts'

test('exposes the high-level factory and its types', () => {
  expect(typeof pkg.reatomOpentelemetry).toBe('function')
})

test('exposes resource override without independent writable trace IDs', () => {
  expect('traceIdVar' in pkg).toBe(false)
  expect('spanIdVar' in pkg).toBe(false)
  expect(pkg.resourceAttributesVar).toBeDefined()
})

test('context methods belong to each adapter', () => {
  const otel = pkg.reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'api',
  })
  try {
    expect(typeof otel.startTrace).toBe('function')
    expect(typeof otel.withContext).toBe('function')
    expect(typeof otel.getCurrentContext).toBe('function')
    expect(otel.getCurrentContext()).toBeUndefined()
  } finally {
    otel.dispose()
  }
})
