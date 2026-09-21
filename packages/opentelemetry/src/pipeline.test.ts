import { action, context, EXTENSIONS } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { installDomStubs } from './test-helpers.ts'

test('capacity includes in-flight records and export is single-flight', async () => {
  const pending: Array<(response: Response) => void> = []
  const fetch = vi.fn(
    () => new Promise<Response>((resolve) => pending.push(resolve)),
  )
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'test',
    maxBatchSize: 1,
    maxQueueSize: 2,
    fetch,
  })
  try {
    const work = action(() => 42, 'work')
    context.start(() => {
      for (let i = 0; i < 12; i++) expect(work()).toBe(42)
    })
    expect(otel.stats()).toMatchObject({
      inFlight: 1,
      queued: 1,
      droppedByReason: { capacity: 10 },
    })
    await Promise.resolve()
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    otel.dispose()
    for (const resolve of pending) resolve(new Response(null))
    await otel.flush()
  }
})

test.each([
  ['maxQueueSize', 0],
  ['maxQueueSize', Number.NaN],
  ['maxBatchSize', -1],
  ['maxBatchSize', 1.5],
  ['batchInterval', 0],
  ['batchInterval', Infinity],
  ['exportTimeoutMs', 0],
  ['exportTimeoutMs', Infinity],
] as const)(
  'invalid %s=%s is rejected before installing instrumentation',
  (key: string, value: number) => {
    const before = [...EXTENSIONS]
    let otel: ReturnType<typeof reatomOpentelemetry> | undefined
    try {
      expect(() => {
        otel = reatomOpentelemetry({
          endpoint: 'http://collector.invalid',
          serviceName: 'test',
          [key]: value,
        })
      }).toThrow(RangeError)
      expect(EXTENSIONS).toEqual(before)
    } finally {
      otel?.dispose()
    }
  },
)

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const emit = (count = 1) => {
  const work = action(() => 42, 'work')
  context.start(() => {
    for (let i = 0; i < count; i++) work()
  })
}

const base = {
  endpoint: 'http://collector.invalid',
  serviceName: 'test',
  batchInterval: 100_000,
  maxBatchSize: 1,
  maxQueueSize: 20,
  exportTimeoutMs: 30_000,
  retry: { maxRetries: 0 },
}

test('flush wait deadlines are independent of each other and each batch deadline', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const requests: Array<
    ReturnType<typeof deferred<Response>> & { signal: AbortSignal }
  > = []
  const otel = reatomOpentelemetry({
    ...base,
    fetch: async (_url, init) => {
      const request = { ...deferred<Response>(), signal: init!.signal! }
      requests.push(request)
      request.signal.addEventListener(
        'abort',
        () => request.reject(request.signal.reason),
        { once: true },
      )
      return request.promise
    },
  })
  try {
    emit(2)
    let aDone = false,
      bDone = false
    const a = otel.flush().then(() => {
      aDone = true
    })
    await vi.advanceTimersByTimeAsync(20_000)
    requests[0]!.resolve(new Response(null))
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5_000)
    const b = otel.flush().then(() => {
      bDone = true
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await a
    expect(aDone).toBe(true)
    expect(bDone).toBe(false)
    expect(requests[1]!.signal.aborted).toBe(false)
    expect(otel.stats()).toMatchObject({
      exported: 1,
      inFlight: 1,
      dropped: 0,
      flushTimeouts: 1,
    })
    await vi.advanceTimersByTimeAsync(19_999)
    expect(requests[1]!.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await b
    expect(requests[1]!.signal.aborted).toBe(true)
    expect(otel.stats()).toMatchObject({
      inFlight: 0,
      exported: 1,
      dropped: 1,
      droppedByReason: { timeout: 1 },
      flushTimeouts: 1,
    })
  } finally {
    otel.dispose()
    warn.mockRestore()
    vi.useRealTimers()
  }
})

test('background exports have a batch deadline without a flush caller', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let signal!: AbortSignal
  const otel = reatomOpentelemetry({
    ...base,
    maxBatchSize: 10,
    batchInterval: 1000,
    fetch: async (_url, init) => {
      signal = init!.signal!
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      )
    },
  })
  try {
    emit()
    await vi.advanceTimersByTimeAsync(1000)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(signal.aborted).toBe(true)
    expect(otel.stats()).toMatchObject({
      inFlight: 0,
      droppedByReason: { timeout: 1 },
      flushTimeouts: 0,
    })
  } finally {
    otel.dispose()
    warn.mockRestore()
    vi.useRealTimers()
  }
})

test.each([400, 503])(
  'HTTP %i body cleanup owns the slot before release or retry',
  async (status: number) => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cleanup = deferred<void>()
    const events: string[] = []
    const body = new ReadableStream({
      cancel: async () => {
        events.push('cancel-start')
        await cleanup.promise
        events.push('cancel-settled')
      },
    })
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status }))
      .mockImplementationOnce(async () => {
        events.push('next-fetch')
        return new Response(null)
      })
    const otel = reatomOpentelemetry({
      ...base,
      fetch,
      retry: { maxRetries: 1, baseDelayMs: 0 },
    })
    try {
      emit()
      let done = false
      const flush = otel.flush().then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(events).toEqual(['cancel-start'])
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(done).toBe(false)
      expect(otel.stats()).toMatchObject({
        inFlight: 1,
        exported: 0,
        dropped: 0,
      })
      cleanup.resolve()
      await vi.advanceTimersByTimeAsync(1)
      await flush
      expect(events).toEqual(
        status === 503
          ? ['cancel-start', 'cancel-settled', 'next-fetch']
          : ['cancel-start', 'cancel-settled'],
      )
      expect(otel.stats()).toMatchObject({
        inFlight: 0,
        exported: status === 503 ? 1 : 0,
        dropped: status === 400 ? 1 : 0,
      })
    } finally {
      cleanup.resolve()
      otel.dispose()
      warn.mockRestore()
      vi.useRealTimers()
    }
  },
)

test('a hanging success body is not treated as empty success after timeout', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let body!: ReadableStreamDefaultController
  const stream = new ReadableStream({
    start(controller) {
      body = controller
    },
  })
  const fetch = vi.fn(async () => new Response(stream))
  const otel = reatomOpentelemetry({ ...base, fetch })
  try {
    emit()
    const flush = otel.flush()
    await vi.advanceTimersByTimeAsync(30_001)
    await flush
    emit()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(otel.stats()).toMatchObject({
      inFlight: 1,
      queued: 1,
      exported: 0,
      dropped: 0,
      transportQuarantined: true,
    })
    otel.dispose()
    expect(otel.stats()).toMatchObject({
      inFlight: 1,
      queued: 0,
      droppedByReason: { disposed: 1 },
    })
    body.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(otel.stats()).toMatchObject({
      inFlight: 0,
      exported: 0,
      droppedByReason: { timeout: 1, disposed: 1 },
      transportQuarantined: false,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  } finally {
    otel.dispose()
    warn.mockRestore()
    vi.useRealTimers()
  }
})

test('cleanup ignoring abort holds the lease until late settlement', async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const cleanup = deferred<void>()
  const body = new ReadableStream({ cancel: () => cleanup.promise })
  const fetch = vi.fn(async () => new Response(body, { status: 503 }))
  const otel = reatomOpentelemetry({
    ...base,
    fetch,
    retry: { maxRetries: 1, baseDelayMs: 0 },
  })
  try {
    emit()
    const flush = otel.flush()
    await vi.advanceTimersByTimeAsync(30_001)
    await flush
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(otel.stats()).toMatchObject({
      inFlight: 1,
      dropped: 0,
      transportQuarantined: true,
    })
    cleanup.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(otel.stats()).toMatchObject({
      inFlight: 0,
      exported: 0,
      droppedByReason: { timeout: 1 },
      transportQuarantined: false,
    })
  } finally {
    cleanup.resolve()
    otel.dispose()
    warn.mockRestore()
    vi.useRealTimers()
  }
})

test('Retry-After beyond the batch budget drops as timeout without early retry', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const fetch = vi.fn(
    async () =>
      new Response('unavailable', {
        status: 503,
        headers: { 'Retry-After': '60' },
      }),
  )
  const otel = reatomOpentelemetry({
    ...base,
    fetch,
    retry: { maxRetries: 1, maxDelayMs: 1 },
  })
  try {
    emit()
    await otel.flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(otel.stats()).toMatchObject({
      inFlight: 0,
      exported: 0,
      droppedByReason: { timeout: 1 },
    })
  } finally {
    otel.dispose()
    warn.mockRestore()
  }
})

test('admission precedes traversal and long application promises hold bounded capacity', async () => {
  const payloads: unknown[] = []
  const otel = reatomOpentelemetry({
    ...base,
    captureValues: {},
    maxQueueSize: 1,
    fetch: async (_url, init) => {
      payloads.push(JSON.parse(init!.body as string))
      return new Response(null)
    },
  })
  const pending = deferred<number>()
  let traversals = 0
  const value = new Proxy(
    { known: 42 },
    {
      ownKeys(target) {
        traversals++
        return Reflect.ownKeys(target)
      },
    },
  )
  const read = action(() => value, 'read')
  const long = action(() => pending.promise, 'long')
  try {
    context.start(() => expect(read()).toBe(value))
    await otel.flush()
    expect(traversals).toBeGreaterThan(0)
    expect(JSON.stringify(payloads)).toContain('known')
    traversals = 0
    context.start(() => {
      expect(long()).toBe(pending.promise)
      expect(read()).toBe(value)
    })
    expect(traversals).toBe(0)
    expect(otel.stats()).toMatchObject({
      active: 1,
      queued: 0,
      inFlight: 0,
      exported: 1,
      droppedByReason: { capacity: 1 },
    })
    await otel.flush() // Does not wait for the application promise.
    otel.dispose()
    pending.resolve(7)
    expect(await pending.promise).toBe(7)
    expect(otel.stats()).toMatchObject({
      active: 0,
      droppedByReason: { disposed: 1, capacity: 1 },
    })
  } finally {
    pending.resolve(7)
    otel.dispose()
  }
})

test('failed observation releases its reservation and subsequent work still exports', async () => {
  const otel = reatomOpentelemetry({
    ...base,
    maxQueueSize: 1,
    fetch: async () => new Response(null),
  })
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  const bad = action(() => proxy, 'bad')
  try {
    context.start(() => expect(bad() === proxy).toBe(true))
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      droppedByReason: { observation: 1 },
    })
    emit()
    await otel.flush()
    expect(otel.stats()).toMatchObject({ exported: 1, dropped: 1 })
  } finally {
    otel.dispose()
  }
})

test('partial rejection has exact immutable terminal statistics', async () => {
  const otel = reatomOpentelemetry({
    ...base,
    maxBatchSize: 10,
    fetch: async () =>
      new Response(JSON.stringify({ partialSuccess: { rejectedSpans: 3 } })),
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const before = otel.stats()
    emit(10)
    await otel.flush()
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 7,
      dropped: 3,
      droppedByReason: { export: 3 },
    })
    expect(before.exported).toBe(0)
    expect(before.droppedByReason.export).toBe(0)
    expect(Object.isFrozen(otel.stats().droppedByReason)).toBe(true)
  } finally {
    otel.dispose()
    warn.mockRestore()
  }
})

test.each(['accepted', 'refused', 'throw'] as const)(
  'beacon %s accounts separately for excluded and selected records',
  async (outcome: string) => {
    const { windowListeners, restore } = installDomStubs()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sendBeacon = vi.fn<(url: string, body: BodyInit) => boolean>(() => {
      if (outcome === 'throw') throw new Error('beacon failure')
      return outcome === 'accepted'
    })
    const fetch = vi.fn(async () => new Response(null))
    const otel = reatomOpentelemetry({
      ...base,
      maxBatchSize: 10,
      useBeacon: true,
      sendBeacon,
      fetch,
    })
    try {
      // Four records fit the shared 60 KiB budget; the oldest fifth does not.
      const names = Array.from(
        { length: 5 },
        (_, i) => `record-${i}-` + 'x'.repeat(14_000),
      )
      context.start(() => {
        for (const name of names) action(() => 42, name)()
      })
      windowListeners.get('pagehide')!()
      windowListeners.get('pagehide')!()
      await otel.flush()
      expect(sendBeacon).toHaveBeenCalledTimes(1)
      expect(fetch).not.toHaveBeenCalled()
      const blob = sendBeacon.mock.calls[0]![1] as Blob
      expect(blob.size).toBeLessThanOrEqual(60 * 1024)
      const body = JSON.parse(await blob.text())
      const spans = body.resourceSpans.flatMap(
        (resource: { scopeSpans: { spans: { name: string }[] }[] }) =>
          resource.scopeSpans.flatMap((scope) => scope.spans),
      )
      expect(spans.map((span: { name: string }) => span.name)).toEqual(
        names.slice(1),
      )
      expect(otel.stats()).toMatchObject({
        queued: 0,
        inFlight: 0,
        exported: 0,
        beaconAccepted: outcome === 'accepted' ? 4 : 0,
        dropped: outcome === 'accepted' ? 1 : 5,
        droppedByReason: {
          oversized: 1,
          export: outcome === 'accepted' ? 0 : 4,
        },
      })
      emit()
      windowListeners.get('pagehide')!()
      expect(sendBeacon).toHaveBeenCalledTimes(2)
    } finally {
      otel.dispose()
      restore()
      warn.mockRestore()
    }
  },
)

test('unload does not steal a normal export slot or count unsent records as lost', async () => {
  const { windowListeners, restore } = installDomStubs()
  const pending = deferred<Response>()
  const fetch = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(new Response(null))
  const sendBeacon = vi.fn(() => true)
  const otel = reatomOpentelemetry({
    ...base,
    fetch,
    useBeacon: true,
    sendBeacon,
  })
  try {
    emit(2)
    windowListeners.get('pagehide')!()
    expect(sendBeacon).not.toHaveBeenCalled()
    expect(otel.stats()).toMatchObject({ queued: 1, inFlight: 1, dropped: 0 })
    const flush = otel.flush()
    pending.resolve(new Response(null))
    await flush
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(otel.stats()).toMatchObject({ exported: 2, dropped: 0 })
  } finally {
    pending.resolve(new Response(null))
    otel.dispose()
    restore()
  }
})

test('an ID-generation failure releases admission before the application continues', async () => {
  const otel = reatomOpentelemetry({
    ...base,
    maxQueueSize: 1,
    fetch: async () => new Response(null),
  })
  const work = action(() => 42, 'work')
  const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation(() => {
    throw new Error('random unavailable')
  })
  try {
    context.start(() => expect(work()).toBe(42))
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      droppedByReason: { observation: 1 },
    })
    random.mockRestore()
    context.start(() => expect(work()).toBe(42))
    await otel.flush()
    expect(otel.stats()).toMatchObject({ exported: 1, dropped: 1 })
  } finally {
    random.mockRestore()
    otel.dispose()
  }
})
