import { action, context } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { installDomStubs, withWarnSpy } from './test-helpers.ts'

const RECORDS = 5

const setup = (body: string) => {
  const requests: string[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'partial-success-test',
    batchInterval: 100_000,
    maxBatchSize: RECORDS,
    maxQueueSize: RECORDS,
    retry: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
    fetch: async (_url, init) => {
      requests.push(String(init?.body))
      return new Response(body, { status: 200 })
    },
  })
  const record = action(() => 42, 'partial.success.record')
  const emit = () =>
    context.start(() => {
      for (let index = 0; index < RECORDS; index++) {
        expect(record()).toBe(42)
      }
    })
  const assertConservation = () => {
    const stats = otel.stats()
    expect(stats.active).toBe(0)
    expect(stats.queued).toBe(0)
    expect(stats.inFlight).toBe(0)
    expect(stats.exported + stats.beaconAccepted + stats.dropped).toBe(RECORDS)
  }
  return { otel, requests, emit, assertConservation }
}

test.each([
  [4, 'number'],
  ['4', 'decimal string'],
] as const)(
  'partialSuccess rejectedSpans=%s (%s) releases five records with no retry',
  async (rejectedSpans: number | string) => {
    const { otel, requests, emit, assertConservation } = setup(
      JSON.stringify({
        partialSuccess: { rejectedSpans, errorMessage: 'collector rejected' },
      }),
    )
    await withWarnSpy(async (warn) => {
      try {
        emit()
        await otel.flush()

        expect(requests).toHaveLength(1)
        const stats = otel.stats()
        expect(stats).toMatchObject({
          active: 0,
          queued: 0,
          inFlight: 0,
          exported: 1,
          dropped: 4,
          droppedByReason: { export: 4 },
        })
        expect(Object.isFrozen(stats.droppedByReason)).toBe(true)
        assertConservation()
        expect(warn).toHaveBeenCalledTimes(1)
        const joined = warn.mock.calls[0]!.map((a) => String(a)).join(' ')
        expect(joined).toContain('partialSuccess')
        expect(joined).toMatch(/4/)
        expect(joined).toContain('collector rejected')
      } finally {
        otel.dispose()
      }
    })
  },
)

test('zero rejectedSpans with a server warning exports all five and warns', async () => {
  const { otel, requests, emit, assertConservation } = setup(
    JSON.stringify({
      partialSuccess: { rejectedSpans: 0, errorMessage: 'collector warning' },
    }),
  )
  await withWarnSpy(async (warn) => {
    try {
      emit()
      await otel.flush()

      expect(requests).toHaveLength(1)
      expect(otel.stats()).toMatchObject({ exported: 5, dropped: 0 })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]![0])).toContain('collector warning')
      assertConservation()
    } finally {
      otel.dispose()
    }
  })
})

test.each([
  ['malformed JSON', '{'],
  ['type-confused partialSuccess', '{"partialSuccess":[]}'],
  [
    'rejectedSpans larger than the sent batch',
    '{"partialSuccess":{"rejectedSpans":6}}',
  ],
] as const)(
  'invalid 2xx %s drops all five records without retry',
  async (_label: string, body: string) => {
    const { otel, requests, emit, assertConservation } = setup(body)
    await withWarnSpy(async (warn) => {
      try {
        emit()
        await otel.flush()

        expect(requests).toHaveLength(1)
        expect(otel.stats()).toMatchObject({
          exported: 0,
          dropped: 5,
          droppedByReason: { export: 5 },
        })
        expect(warn).toHaveBeenCalledTimes(1)
        assertConservation()
      } finally {
        otel.dispose()
      }
    })
  },
)

test.each([
  ['empty body', ''],
  ['missing partialSuccess', '{}'],
] as const)(
  '%s accepts all five records',
  async (_label: string, body: string) => {
    const { otel, requests, emit, assertConservation } = setup(body)
    try {
      emit()
      await otel.flush()

      expect(requests).toHaveLength(1)
      expect(otel.stats()).toMatchObject({ exported: 5, dropped: 0 })
      assertConservation()
    } finally {
      otel.dispose()
    }
  },
)

test.each(['http', 'partial', 'beacon', 'network'] as const)(
  'export diagnostics omit endpoint credentials (%s)',
  async (mode: 'http' | 'partial' | 'beacon' | 'network') => {
    const { windowListeners, restore } = installDomStubs()
    const endpoint =
      'https://user:private-password@collector.invalid?token=private-query#private-fragment'
    await withWarnSpy(async (warn) => {
      const otel = reatomOpentelemetry({
        endpoint,
        serviceName: 'diagnostic-privacy',
        retry: { maxRetries: 0 },
        useBeacon: mode === 'beacon',
        sendBeacon: () => false,
        fetch: async () => {
          if (mode === 'network')
            throw new TypeError(`Cannot fetch ${endpoint}`)
          return mode === 'http'
            ? new Response(null, { status: 400 })
            : new Response(
                '{"partialSuccess":{"errorMessage":"collector warning"}}',
              )
        },
      })
      try {
        context.start(() => action(() => 7, 'diagnostic.action')())
        if (mode === 'beacon') windowListeners.get('pagehide')!()
        else await otel.flush()
        expect(warn).toHaveBeenCalledTimes(1)
        const diagnostic = warn.mock.calls.flat().map(String).join(' ')
        expect(diagnostic).not.toContain('private-')
        expect(diagnostic).not.toContain('user:')
        expect(otel.stats()).toMatchObject(
          mode === 'partial'
            ? { exported: 1, dropped: 0 }
            : { exported: 0, droppedByReason: { export: 1 } },
        )
      } finally {
        otel.dispose()
        restore()
      }
    })
  },
)

test.each([0, 1])(
  'response limit counts bytes rather than characters (excess=%s)',
  async (excess: number) => {
    // A valid JSON object with multibyte whitespace content in an unknown field.
    const text =
      '{"padding":"' + '界'.repeat(21840) + 'a'.repeat(2 + excess) + '"}'
    expect(new TextEncoder().encode(text)).toHaveLength(64 * 1024 + excess)
    const { otel, emit, requests, assertConservation } = setup(text)
    await withWarnSpy(async () => {
      try {
        emit()
        await otel.flush()
        expect(requests).toHaveLength(1)
        expect(otel.stats()).toMatchObject(
          excess
            ? { exported: 0, dropped: 5, droppedByReason: { export: 5 } }
            : { exported: 5, dropped: 0 },
        )
        assertConservation()
      } finally {
        otel.dispose()
      }
    })
  },
)
