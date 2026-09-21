import { expect, test, vi } from 'vitest'

import { flushWithBeacon } from './flushWithBeacon.ts'

test('posts the selected JSON unchanged as an application/json Blob', async () => {
  const body = JSON.stringify({ resourceSpans: [{ name: 'привет' }] })
  const sendBeacon = vi.fn<(url: string, data: BodyInit) => boolean>(() => true)
  expect(
    flushWithBeacon({
      endpoint: 'https://collector.example/',
      body,
      sendBeacon,
    }),
  ).toBe(true)
  expect(sendBeacon).toHaveBeenCalledTimes(1)
  const [url, blob] = sendBeacon.mock.calls[0]!
  expect(url).toBe('https://collector.example/v1/traces')
  expect(blob).toBeInstanceOf(Blob)
  expect((blob as Blob).type).toBe('application/json')
  expect(await (blob as Blob).text()).toBe(body)
})

test.each(['refused', 'throw'] as const)(
  'returns false when beacon is %s',
  (outcome: 'refused' | 'throw') => {
    const sendBeacon = vi.fn(() => {
      if (outcome === 'throw') throw new Error('unavailable')
      return false
    })
    expect(
      flushWithBeacon({
        endpoint: 'https://collector.example',
        body: '{}',
        sendBeacon,
      }),
    ).toBe(false)
    expect(sendBeacon).toHaveBeenCalledTimes(1)
  },
)

test('skips transport for an empty selection', () => {
  const sendBeacon = vi.fn(() => true)
  expect(
    flushWithBeacon({
      endpoint: 'https://collector.example',
      body: '',
      sendBeacon,
    }),
  ).toBe(true)
  expect(sendBeacon).not.toHaveBeenCalled()
})

test('returns false when the browser API is unavailable', () => {
  expect(
    flushWithBeacon({ endpoint: 'https://collector.example', body: '{}' }),
  ).toBe(false)
})
