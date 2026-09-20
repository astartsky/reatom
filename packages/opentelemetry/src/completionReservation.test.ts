import { action, computed, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'

interface WirePayload {
  resourceSpans: Array<{
    scopeSpans: Array<{ spans: Array<{ name: string }> }>
  }>
}

const base = {
  endpoint: 'http://collector.invalid',
  serviceName: 'test',
  maxQueueSize: 1,
  maxBatchSize: 1,
  retry: { maxRetries: 0 },
}

test('suspension and hostile-error observation free capacity; later work exports one span', async () => {
  const fetchMock = vi.fn<typeof globalThis.fetch>(
    async () => new Response(null, { status: 200 }),
  )
  let failingCaptures = 0
  let liveCaptures = 0
  const otel = reatomOpentelemetry({
    ...base,
    fetch: fetchMock,
    captureValues: {
      redact(key: string, value: unknown) {
        if (key === 'exception.message' && value === 'application failure') {
          failingCaptures++
          throw new Error('observer failure')
        }
        if (key === 'payload' && value === 'ok') liveCaptures++
        return value
      },
    },
  })
  try {
    const suspense = Promise.resolve('suspense')
    let suspendingCalls = 0
    const suspending = computed(() => {
      suspendingCalls++
      throw suspense
    }, 'suspending')
    context.start(() => {
      let caught: unknown
      try {
        suspending()
      } catch (error) {
        caught = error
      }
      expect(caught === suspense).toBe(true)
      expect(suspendingCalls).toBe(1)
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      dropped: 0,
      droppedByReason: { observation: 0 },
    })

    const original = new Error('application failure')
    let failingCalls = 0
    const failing = action(() => {
      failingCalls++
      throw original
    }, 'failing')
    context.start(() => {
      let caught: unknown
      try {
        failing()
      } catch (error) {
        caught = error
      }
      expect(caught === original).toBe(true)
      expect(failingCalls).toBe(1)
    })
    expect(failingCaptures).toBe(1)
    expect(liveCaptures).toBe(0)
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      dropped: 1,
      droppedByReason: { observation: 1 },
    })

    const ordinary = action(() => 'ok', 'ordinary')
    context.start(() => {
      expect(ordinary()).toBe('ok')
    })
    expect(liveCaptures).toBe(1)
    expect(failingCaptures).toBe(1)
    await otel.flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(
      String(fetchMock.mock.calls[0]![1]!.body),
    ) as WirePayload
    const spans = payload.resourceSpans.flatMap((rs) =>
      rs.scopeSpans.flatMap((ss) => ss.spans),
    )
    expect(spans.map((s) => s.name)).toEqual(['ordinary'])
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 1,
    })
  } finally {
    otel.dispose()
    vi.restoreAllMocks()
  }
})

test('a 200 body whose stream errors before the deadline drops as export, with no retry', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let bodyController!: ReadableStreamDefaultController
  const stream = new ReadableStream({
    start(controller) {
      bodyController = controller
    },
  })
  const responses: Response[] = []
  const fetchMock = vi.fn(async () => {
    const response = new Response(stream, { status: 200 })
    responses.push(response)
    return response
  })
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'test',
    batchInterval: 100_000,
    maxBatchSize: 1,
    maxQueueSize: 20,
    exportTimeoutMs: 30_000,
    retry: { maxRetries: 0 },
    fetch: fetchMock,
  })
  try {
    const work = action(() => 42, 'work')
    context.start(() => {
      work()
    })
    const flush = otel.flush()
    // Controlled microtask drain: the worker has actually begun reading the body.
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(responses[0]!.bodyUsed).toBe(true)

    // Fail the stream well before the export deadline.
    bodyController.error(new Error('stream failed'))
    await flush

    const stats = otel.stats()
    expect(stats.exported).toBe(0)
    expect(stats.droppedByReason.export).toBe(1)
    expect(stats.inFlight).toBe(0)
    expect(stats.flushTimeouts).toBe(0)
    // Exactly one fetch, no retry after the failed body read.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  } finally {
    otel.dispose()
    warn.mockRestore()
    vi.useRealTimers()
  }
})
