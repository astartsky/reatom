import { action, context } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { withWarnSpy } from './test-helpers.ts'

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
    try {
      emit()
      await otel.flush()

      expect(requests).toHaveLength(1)
      expect(otel.stats()).toMatchObject({
        exported: 1,
        dropped: 4,
        droppedByReason: { export: 4 },
      })
      assertConservation()
    } finally {
      otel.dispose()
    }
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
  ['nonempty whitespace body', '  \n'],
  ['null top-level', 'null'],
  ['array top-level', '[]'],
  ['scalar top-level', '1'],
  ['null partialSuccess', '{"partialSuccess":null}'],
  ['array partialSuccess', '{"partialSuccess":[]}'],
  ['negative rejectedSpans', '{"partialSuccess":{"rejectedSpans":-1}}'],
  ['fractional rejectedSpans', '{"partialSuccess":{"rejectedSpans":1.5}}'],
  [
    'unsafe rejectedSpans number',
    '{"partialSuccess":{"rejectedSpans":9007199254740992}}',
  ],
  [
    'rejectedSpans larger than the sent batch',
    '{"partialSuccess":{"rejectedSpans":6}}',
  ],
  [
    'int64 rejectedSpans larger than the sent batch',
    '{"partialSuccess":{"rejectedSpans":"9223372036854775807"}}',
  ],
  [
    'rejectedSpans beyond int64',
    '{"partialSuccess":{"rejectedSpans":"9223372036854775808"}}',
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
