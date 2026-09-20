import { action, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

const LIMIT = 60 * 1024
const bytes = (body: string) => new TextEncoder().encode(body).length
const base = {
  endpoint: 'http://collector.invalid',
  serviceName: 'unload-budget',
  batchInterval: 100_000,
  maxBatchSize: 20,
  maxQueueSize: 40,
}

const installDocument = () => {
  const page = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const view = new EventTarget()
  vi.stubGlobal('document', page)
  vi.stubGlobal('window', view)
  return {
    hide() {
      page.visibilityState = 'hidden'
      page.dispatchEvent(new Event('visibilitychange'))
      view.dispatchEvent(new Event('pagehide'))
    },
  }
}

const emit = (prefix: string, count: number, size = 4000) => {
  const names = Array.from(
    { length: count },
    (_, i) => `${prefix}.${i}.` + '界'.repeat(size),
  )
  context.start(() => {
    for (const name of names) expect(action(() => 7, name)()).toBe(7)
  })
  return names
}

test('keepalive selection includes the UTF-8 envelope and preserves mixed partial outcomes', async () => {
  const page = installDocument()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const bodies: string[] = []
  const requests: Array<RequestInit | undefined> = []
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body))
    requests.push(init)
    if (requests.length === 1) {
      return new Response(
        JSON.stringify({ partialSuccess: { rejectedSpans: 3 } }),
      )
    }
    return new Response('{}')
  })
  const otel = reatomOpentelemetry({ ...base, fetch })
  try {
    emit('older', 2, 4900)
    const kept = emit('newer', 8, 2000)
    page.hide()
    await otel.flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(requests[0]?.keepalive).toBe(true)
    expect(bytes(bodies[0]!)).toBeLessThanOrEqual(LIMIT)
    expect(parseSpans(bodies[0]!).map((span) => span.name)).toEqual(kept)
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 5,
      dropped: 5,
      droppedByReason: { oversized: 2, export: 3 },
    })

    const ordinary = emit('ordinary', 3, 1)
    await otel.flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(requests[1]?.keepalive).toBe(false)
    expect(parseSpans(bodies[1]!).map((span) => span.name)).toEqual(ordinary)
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 8,
      dropped: 5,
      droppedByReason: { oversized: 2, export: 3 },
    })
  } finally {
    otel.dispose()
    warn.mockRestore()
    vi.unstubAllGlobals()
  }
})

test('HTTP 503 unload keeps document credit through cancel and never retries', async () => {
  const page = installDocument()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const firstBodies: string[] = []
  const secondBodies: string[] = []
  let enterCancel!: () => void
  const cancelStarted = new Promise<void>((resolve) => {
    enterCancel = resolve
  })
  let settleCancel!: () => void
  const cancelSettled = new Promise<void>((resolve) => {
    settleCancel = resolve
  })
  const fetchA = vi.fn(async (_url: unknown, init?: RequestInit) => {
    firstBodies.push(String(init?.body))
    return new Response(
      new ReadableStream({
        cancel() {
          enterCancel()
          return cancelSettled
        },
      }),
      { status: 503, statusText: 'busy' },
    )
  })
  const fetchB = vi.fn(async (_url: unknown, init?: RequestInit) => {
    secondBodies.push(String(init?.body))
    return new Response('{}')
  })
  const a = reatomOpentelemetry({
    ...base,
    filter: (target) => target.name.startsWith('a.'),
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    fetch: fetchA,
  })
  const b = reatomOpentelemetry({
    ...base,
    filter: (target) => target.name.startsWith('b.'),
    fetch: fetchB,
  })
  try {
    emit('a.older', 2, 4900)
    const kept = emit('a.newer', 8, 2000)
    page.hide()
    await cancelStarted
    expect(fetchA.mock.calls[0]?.[1]?.keepalive).toBe(true)
    expect(fetchA).toHaveBeenCalledTimes(1)
    expect(parseSpans(firstBodies[0]!).map((span) => span.name)).toEqual(kept)
    expect(a.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 10,
      exported: 0,
      dropped: 0,
    })

    emit('b.blocked', 1, 4000)
    page.hide()
    await b.flush()
    expect(fetchB).not.toHaveBeenCalled()
    expect(b.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      dropped: 1,
      droppedByReason: { oversized: 1 },
    })

    settleCancel()
    await a.flush()
    expect(fetchA).toHaveBeenCalledTimes(1)
    expect(a.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 0,
      dropped: 10,
      droppedByReason: { oversized: 2, export: 8 },
    })

    const after = emit('b.after', 1, 4000)
    page.hide()
    await b.flush()
    expect(fetchB).toHaveBeenCalledTimes(1)
    expect(fetchB.mock.calls[0]?.[1]?.keepalive).toBe(true)
    expect(parseSpans(secondBodies[0]!).map((span) => span.name)).toEqual(after)
    expect(bytes(secondBodies[0]!)).toBeLessThanOrEqual(LIMIT)
    expect(b.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 1,
      dropped: 1,
      droppedByReason: { oversized: 1 },
    })
  } finally {
    a.dispose()
    b.dispose()
    settleCancel()
    await Promise.resolve()
    await a.flush()
    await b.flush()
    warn.mockRestore()
    vi.unstubAllGlobals()
  }
})

test.each([false, true])(
  'adapters share pending fetch bytes through body settlement (second beacon=%s)',
  async (useBeacon: boolean) => {
    const page = installDocument()
    const bodies: string[] = []
    let close!: () => void
    const fetchA = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(
        new ReadableStream({
          start(controller) {
            let closed = false
            close = () => {
              if (!closed) controller.close()
              closed = true
            }
          },
        }),
      )
    })
    const fetchB = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return new Response(null)
    })
    const beacons: Blob[] = []
    const sendBeacon = vi.fn((_url: string, body: BodyInit) => {
      beacons.push(body as Blob)
      return true
    })
    const a = reatomOpentelemetry({
      ...base,
      filter: (t) => t.name.startsWith('a.'),
      fetch: fetchA,
    })
    const b = reatomOpentelemetry({
      ...base,
      filter: (t) => t.name.startsWith('b.'),
      fetch: fetchB,
      useBeacon,
      sendBeacon,
    })
    try {
      emit('a', 4)
      page.hide()
      await Promise.resolve()
      expect(fetchA).toHaveBeenCalledTimes(1)
      expect(a.stats().inFlight).toBe(4)
      emit('b', 2)
      page.hide()
      await b.flush()
      expect(fetchB).not.toHaveBeenCalled()
      expect(sendBeacon).not.toHaveBeenCalled()
      expect(b.stats()).toMatchObject({
        dropped: 2,
        droppedByReason: { oversized: 2 },
      })
      close()
      await a.flush()
      const next = emit('b', 2)
      page.hide()
      await b.flush()
      const second = useBeacon ? await beacons[0]!.text() : bodies[1]!
      expect(parseSpans(second).map((s) => s.name)).toEqual(next)
      expect(bytes(second)).toBeLessThanOrEqual(LIMIT)
      expect(b.stats()).toMatchObject({
        exported: useBeacon ? 0 : 2,
        beaconAccepted: useBeacon ? 2 : 0,
        dropped: 2,
        inFlight: 0,
      })
    } finally {
      a.dispose()
      b.dispose()
      close?.()
      await Promise.resolve()
      vi.unstubAllGlobals()
    }
  },
)

test('accepted beacon bytes survive repeated lifecycle events and adapter recreation', async () => {
  const page = installDocument()
  const sent: Blob[] = []
  const sendBeacon = vi.fn((_url: string, body: BodyInit) => {
    sent.push(body as Blob)
    return true
  })
  const fetch = vi.fn(async () => new Response(null))
  let otel = reatomOpentelemetry({
    ...base,
    useBeacon: true,
    sendBeacon,
    fetch,
  })
  try {
    emit('first', 4)
    page.hide()
    expect(otel.stats().beaconAccepted).toBe(4)
    emit('second', 1)
    page.hide()
    expect(sendBeacon).toHaveBeenCalledTimes(1)
    expect(otel.stats().droppedByReason.oversized).toBe(1)
    otel.dispose()
    otel = reatomOpentelemetry({ ...base, useBeacon: true, sendBeacon, fetch })
    emit('recreated', 1)
    page.hide()
    expect(sendBeacon).toHaveBeenCalledTimes(1)
    emit('small', 1, 1)
    page.hide()
    expect(sendBeacon).toHaveBeenCalledTimes(2)
    expect(sent.reduce((sum, blob) => sum + blob.size, 0)).toBeLessThanOrEqual(
      LIMIT,
    )
    expect(otel.stats()).toMatchObject({
      beaconAccepted: 1,
      exported: 0,
      dropped: 1,
      inFlight: 0,
    })
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    otel.dispose()
    vi.unstubAllGlobals()
  }
})

test.each(['fetch', 'beacon'] as const)(
  'dispose while resolving the %s transport prevents a new request',
  async (transport: 'fetch' | 'beacon') => {
    const page = installDocument()
    const send = vi.fn(() =>
      transport === 'fetch' ? Promise.resolve(new Response(null)) : true,
    )
    let otel: ReturnType<typeof reatomOpentelemetry>
    const input = {
      ...base,
      useBeacon: transport === 'beacon',
    }
    Object.defineProperty(
      input,
      transport === 'fetch' ? 'fetch' : 'sendBeacon',
      {
        get() {
          otel.dispose()
          return send
        },
      },
    )
    otel = reatomOpentelemetry(input)
    try {
      emit('dispose', 1, 1)
      page.hide()
      for (let i = 0; i < 8; i++) await Promise.resolve()
      expect(send).not.toHaveBeenCalled()
      expect(otel.stats()).toMatchObject({
        inFlight: 0,
        exported: 0,
        beaconAccepted: 0,
        droppedByReason: { disposed: 1 },
      })
    } finally {
      otel.dispose()
      vi.unstubAllGlobals()
    }
  },
)

test('a window without document does not start an unload transport', () => {
  const view = new EventTarget()
  vi.stubGlobal('window', view)
  vi.stubGlobal('document', undefined)
  const fetch = vi.fn(async () => new Response(null))
  const otel = reatomOpentelemetry({ ...base, fetch })
  try {
    emit('no-document', 1, 1)
    view.dispatchEvent(new Event('pagehide'))
    expect(fetch).not.toHaveBeenCalled()
    expect(otel.stats()).toMatchObject({ queued: 1, inFlight: 0, dropped: 0 })
  } finally {
    otel.dispose()
    vi.unstubAllGlobals()
  }
})

test.each(['export', 'timeout', 'disposed'] as const)(
  '%s keeps excluded records and fetch bytes until body cleanup',
  async (reason: 'export' | 'timeout' | 'disposed') => {
    vi.useFakeTimers()
    const page = installDocument()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let finishBody!: (error?: Error) => void
    let signal!: AbortSignal
    const fetchA = vi.fn(async (_url: unknown, init?: RequestInit) => {
      signal = init!.signal!
      return new Response(
        new ReadableStream({
          start(controller) {
            let finished = false
            finishBody = (error) => {
              if (finished) return
              finished = true
              if (error) controller.error(error)
              else controller.close()
            }
          },
        }),
      )
    })
    const fetchB = vi.fn(async () => new Response(null))
    const a = reatomOpentelemetry({
      ...base,
      exportTimeoutMs: 30,
      filter: (t) => t.name.startsWith('a.'),
      fetch: fetchA,
    })
    const b = reatomOpentelemetry({
      ...base,
      filter: (t) => t.name.startsWith('b.'),
      fetch: fetchB,
    })
    try {
      emit('a.older', 2, 4900)
      emit('a.newer', 8, 2000)
      page.hide()
      await vi.advanceTimersByTimeAsync(0)
      if (reason === 'timeout') await vi.advanceTimersByTimeAsync(31)
      if (reason === 'disposed') a.dispose()
      expect(signal.aborted).toBe(reason !== 'export')
      expect(a.stats()).toMatchObject({ inFlight: 10, dropped: 0, exported: 0 })
      emit('b.pending', 1)
      page.hide()
      await b.flush()
      expect(fetchB).not.toHaveBeenCalled()
      expect(b.stats().droppedByReason.oversized).toBe(1)
      finishBody(reason === 'export' ? new Error('body failed') : undefined)
      await vi.advanceTimersByTimeAsync(0)
      expect(a.stats().inFlight).toBe(0)
      expect(a.stats()).toMatchObject({
        exported: 0,
        dropped: 10,
        droppedByReason: { oversized: 2, [reason]: 8 },
      })
      emit('b.after', 1)
      page.hide()
      await b.flush()
      expect(fetchB).toHaveBeenCalledTimes(1)
      expect(b.stats()).toMatchObject({ exported: 1, dropped: 1 })
    } finally {
      a.dispose()
      b.dispose()
      finishBody?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(a.stats().inFlight).toBe(0)
      warn.mockRestore()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  },
)

test.each(['false', 'throw'])(
  'beacon %s releases its byte reservation for the next batch',
  async (outcome: string) => {
    const page = installDocument()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let first = true
    const sendBeacon = vi.fn(() => {
      if (!first) return true
      first = false
      if (outcome === 'throw') throw new Error('beacon refused')
      return false
    })
    const otel = reatomOpentelemetry({ ...base, useBeacon: true, sendBeacon })
    try {
      emit('refused', 4)
      page.hide()
      expect(otel.stats()).toMatchObject({ dropped: 4, beaconAccepted: 0 })
      emit('accepted', 4)
      page.hide()
      expect(sendBeacon).toHaveBeenCalledTimes(2)
      expect(otel.stats()).toMatchObject({
        dropped: 4,
        beaconAccepted: 4,
        inFlight: 0,
      })
    } finally {
      otel.dispose()
      warn.mockRestore()
      vi.unstubAllGlobals()
    }
  },
)
