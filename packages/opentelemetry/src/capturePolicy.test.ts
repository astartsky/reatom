import { action, bind, context, wrap } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

const createRun = () =>
  context.start(() => bind(<T>(callback: () => T) => callback()))

const policyInput = {
  endpoint: 'https://collector.invalid',
  serviceName: 'capture-policy',
  batchInterval: 100_000,
  maxBatchSize: 10,
  maxQueueSize: 10,
  retry: { maxRetries: 0 },
  captureValues: {},
} as const

test('R05 captures sync action params before its body and owns the completed payload', async () => {
  const bodies: string[] = []
  const run = createRun()
  const otel = reatomOpentelemetry({
    ...policyInput,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  const params = { value: 'R05_sync_before' }
  const output = { result: 'R05_sync_after' }
  let bodyCalls = 0
  try {
    const target = run(() =>
      action((received: typeof params) => {
        bodyCalls++
        expect(received).toBe(params)
        received.value = 'R05_sync_inside'
        return output
      }, 'capture-policy.r05-sync'),
    )

    expect(run(() => target(params))).toBe(output)
    expect(bodyCalls).toBe(1)
    params.value = 'R05_sync_late_input'
    output.result = 'R05_sync_late_payload'

    await otel.flush()
    const [span] = bodies.flatMap(parseSpans)
    expect(span?.name).toBe('capture-policy.r05-sync')
    const capturedParams = JSON.parse(String(span?.attributes.params))
    const capturedPayload = JSON.parse(String(span?.attributes.payload))
    expect(capturedParams).toEqual([{ value: 'R05_sync_before' }])
    expect(capturedPayload).toEqual({ result: 'R05_sync_after' })
    expect(bodies.join('')).not.toContain('R05_sync_inside')
    expect(bodies.join('')).not.toContain('R05_sync_late_input')
    expect(bodies.join('')).not.toContain('R05_sync_late_payload')
  } finally {
    otel.dispose()
  }
})

test('R05 async action retains its original promise and owns begin and completion snapshots', async () => {
  const bodies: string[] = []
  const run = createRun()
  const otel = reatomOpentelemetry({
    ...policyInput,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  const gate = Promise.withResolvers<void>()
  const params = { value: 'R05_async_before' }
  const output = { result: 'R05_async_after' }
  let originalPromise!: Promise<typeof output>
  try {
    const target = run(() =>
      action((received: typeof params) => {
        originalPromise = (async () => {
          received.value = 'R05_async_inside'
          await wrap(gate.promise)
          return output
        })()
        return originalPromise
      }, 'capture-policy.r05-async'),
    )

    const applicationPromise = run(() => target(params))
    expect(applicationPromise).toBe(originalPromise)
    gate.resolve()
    // The observer registers its completion handler during invocation, before
    // this caller awaits the original promise. The extra microtask confirms
    // that handler has committed before the deliberately late mutations.
    expect(await originalPromise).toBe(output)
    await Promise.resolve()
    expect(otel.stats()).toMatchObject({ active: 0, queued: 1 })
    params.value = 'R05_async_late_input'
    output.result = 'R05_async_late_payload'

    await otel.flush()
    const [span] = bodies.flatMap(parseSpans)
    expect(span?.name).toBe('capture-policy.r05-async')
    expect(JSON.parse(String(span?.attributes.params))).toEqual([
      { value: 'R05_async_before' },
    ])
    expect(JSON.parse(String(span?.attributes.payload))).toEqual({
      result: 'R05_async_after',
    })
    expect(bodies.join('')).not.toContain('R05_async_inside')
    expect(bodies.join('')).not.toContain('R05_async_late_input')
    expect(bodies.join('')).not.toContain('R05_async_late_payload')
  } finally {
    gate.resolve()
    await originalPromise?.catch(() => {})
    otel.dispose()
  }
})

test('R06 uses key-aware redaction in the final OTLP body without changing the app result', async () => {
  const bodies: string[] = []
  const run = createRun()
  const otel = reatomOpentelemetry({
    ...policyInput,
    captureValues: {
      redact: (key, value) => (key === 'private' ? '[redacted]' : value),
    },
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  const output = {
    private: 'R06_private_sentinel',
    public: 'R06_public_sentinel',
  }
  try {
    const target = run(() => action(() => output, 'capture-policy.r06-redact'))
    expect(run(target)).toBe(output)
    expect(output.private).toBe('R06_private_sentinel')

    await otel.flush()
    const [span] = bodies.flatMap(parseSpans)
    expect(span?.name).toBe('capture-policy.r06-redact')
    expect(bodies.join('')).toContain('[redacted]')
    expect(bodies.join('')).toContain('R06_public_sentinel')
    expect(bodies.join('')).not.toContain('R06_private_sentinel')
  } finally {
    otel.dispose()
  }
})

test('R06 drops a throwing redaction observation and releases its reservation', async () => {
  const bodies: string[] = []
  const run = createRun()
  const otel = reatomOpentelemetry({
    ...policyInput,
    captureValues: {
      redact: (key, value) => {
        if (key === 'private') throw new Error('R06 redact failure')
        return value
      },
    },
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  const control = { public: 'R06_positive_control' }
  const privateOutput = { private: 'R06_throwing_private' }
  try {
    const [controlTarget, target] = run(() => [
      action(() => control, 'capture-policy.r06-control'),
      action(() => privateOutput, 'capture-policy.r06-throwing'),
    ])
    expect(run(controlTarget)).toBe(control)
    expect(run(target)).toBe(privateOutput)
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 1,
      droppedByReason: { observation: 1 },
    })

    await otel.flush()
    expect(bodies.flatMap(parseSpans).map((span) => span.name)).toEqual([
      'capture-policy.r06-control',
    ])
    expect(bodies.join('')).toContain('R06_positive_control')
    expect(bodies.join('')).not.toContain('R06_throwing_private')
  } finally {
    otel.dispose()
  }
})

test('R04 only admitted records traverse, redact, and export values', async () => {
  const bodies: string[] = []
  const run = createRun()
  const traversal = { ownKeys: 0, descriptors: 0, redact: 0 }
  let admittedOriginal: object | undefined
  let rejectedOriginal: object | undefined
  const makeValue = () =>
    new Proxy(
      { public: 'R04_admitted_public' },
      {
        ownKeys(target) {
          traversal.ownKeys++
          return Reflect.ownKeys(target)
        },
        getOwnPropertyDescriptor(target, key) {
          traversal.descriptors++
          return Reflect.getOwnPropertyDescriptor(target, key)
        },
      },
    )
  const otel = reatomOpentelemetry({
    ...policyInput,
    maxQueueSize: 1,
    maxBatchSize: 2,
    filter: (target) => target.name.startsWith('capture-policy.r04'),
    captureValues: {
      redact: (_key, value) => {
        traversal.redact++
        return value
      },
    },
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  try {
    const [admitted, rejected] = run(() => [
      action(
        () => (admittedOriginal = makeValue()),
        'capture-policy.r04-admitted',
      ),
      action(
        () => (rejectedOriginal = makeValue()),
        'capture-policy.r04-rejected',
      ),
    ])
    const admittedValue = run(admitted)
    expect(admittedValue).toBe(admittedOriginal)
    expect(traversal.ownKeys + traversal.descriptors).toBeGreaterThan(0)
    expect(traversal.redact).toBeGreaterThan(0)
    expect(otel.stats()).toMatchObject({ queued: 1 })

    traversal.ownKeys = traversal.descriptors = traversal.redact = 0
    const rejectedValue = run(rejected)
    expect(rejectedValue).toBe(rejectedOriginal)
    expect(otel.stats()).toMatchObject({
      queued: 1,
      droppedByReason: { capacity: 1 },
    })
    expect(traversal).toEqual({ ownKeys: 0, descriptors: 0, redact: 0 })
    await otel.flush()
    expect(bodies.join('')).toContain('R04_admitted_public')
  } finally {
    otel.dispose()
  }
})

test('R04 filter and dispose skip value traversal and preserve the returned object', () => {
  const run = createRun()
  const traversal = { ownKeys: 0, descriptors: 0, redact: 0 }
  const value = new Proxy(
    { public: 'R04_rejected_public' },
    {
      ownKeys(target) {
        traversal.ownKeys++
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        traversal.descriptors++
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    },
  )
  const create = (filter?: () => boolean) =>
    reatomOpentelemetry({
      ...policyInput,
      filter,
      captureValues: {
        redact: (_key, redacted) => {
          traversal.redact++
          return redacted
        },
      },
      fetch: async () => new Response(null),
    })
  const filtered = create(() => false)
  try {
    const target = run(() => action(() => value, 'capture-policy.r04-filter'))
    expect(run(target)).toBe(value)
    expect(traversal).toEqual({ ownKeys: 0, descriptors: 0, redact: 0 })
  } finally {
    filtered.dispose()
  }

  const disposed = create()
  try {
    const target = run(() => action(() => value, 'capture-policy.r04-disposed'))
    disposed.dispose()
    expect(run(target)).toBe(value)
    expect(traversal).toEqual({ ownKeys: 0, descriptors: 0, redact: 0 })
  } finally {
    disposed.dispose()
  }
})
