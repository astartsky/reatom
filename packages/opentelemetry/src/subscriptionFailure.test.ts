import { action, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

test('poisoned then cancelling its reservation must not capture on late settlement', async () => {
  const fetchMock = vi.fn<typeof globalThis.fetch>(
    async () => new Response(null, { status: 200 }),
  )
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'test',
    captureValues: {},
    maxQueueSize: 1,
    maxBatchSize: 1,
    retry: { maxRetries: 0 },
    fetch: fetchMock,
  })
  try {
    // Positive capture control: a live span traverses data descriptors and
    // exports. Getter counters would stay zero even with capture enabled.
    let liveReads = 0
    const liveValue = new Proxy(
      { v: 1 },
      {
        ownKeys(target) {
          liveReads++
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor(target, key) {
          liveReads++
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
      },
    )
    const live = action(() => liveValue, 'liveCaptureControl')
    context.start(() => {
      expect(live() === liveValue).toBe(true)
    })
    expect(liveReads).toBeGreaterThan(0)
    await otel.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(otel.stats().exported).toBe(1)
    expect(
      parseSpans(String(fetchMock.mock.calls[0]![1]!.body)).map(
        (span) => span.name,
      ),
    ).toEqual(['liveCaptureControl'])
    fetchMock.mockClear()

    // Controlled application promise: truly pending until we resolve it below.
    const { promise: native, resolve: resolveNative } =
      Promise.withResolvers<unknown>()
    let lateReads = 0
    const lateValue = new Proxy(
      { v: 1 },
      {
        ownKeys(target) {
          lateReads++
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor(target, key) {
          lateReads++
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
      },
    )

    let observation!: Promise<unknown>
    const sentinel = new Error('then registration failure')
    const poisonedThen = (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      // Register exactly what withOTel hands over via the native path, then
      // throw synchronously so the attach attempt fails after registration.
      observation = Promise.prototype.then.call(native, onFulfilled, onRejected)
      throw sentinel
    }
    Object.defineProperty(native, 'then', {
      configurable: true,
      value: poisonedThen,
    })

    const poisoned = action(() => native, 'poisoned')
    let returned: unknown
    context.start(() => {
      returned = poisoned()
    })
    // The application receives the original promise object.
    expect(returned === native).toBe(true)

    // The reservation was cancelled once the poisoned then threw.
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      droppedByReason: { observation: 1 },
    })

    const cancelled = otel.stats()
    expect(observation).toBeInstanceOf(Promise)
    expect(lateReads).toBe(0)
    // Await the actual registered observer chain without calling the tainted then.
    resolveNative(lateValue)
    await observation
    expect(otel.stats()).toEqual(cancelled)
    expect(lateReads).toBe(0)
    // No span/fetch may appear from the cancelled observation.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      droppedByReason: { observation: 1 },
      exported: 1,
    })

    // Ordinary export still works exactly once afterwards.
    const ordinary = action(() => 'ordinary', 'ordinaryAfterPoison')
    context.start(() => {
      expect(ordinary()).toBe('ordinary')
    })
    await otel.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const names = parseSpans(String(fetchMock.mock.calls[0]![1]!.body)).map(
      (span) => span.name,
    )
    expect(names).toEqual(['ordinaryAfterPoison'])
  } finally {
    otel.dispose()
    vi.restoreAllMocks()
  }
})
