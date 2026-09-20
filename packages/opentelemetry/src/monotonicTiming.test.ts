import { action, context, wrap } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

test.each([false, true])(
  'execution duration follows the monotonic clock when wall time reverses (async=%s)',
  async (asynchronous: boolean) => {
    let wall = 1000
    let monotonic = 50
    const wallClock = vi.spyOn(Date, 'now').mockImplementation(() => wall)
    const monotonicClock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonic)
    const bodies: string[] = []
    const otel = reatomOpentelemetry({
      endpoint: 'http://collector.invalid',
      serviceName: 'clock-test',
      filter: (target) => target.name === 'clock.execution',
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response('{}')
      },
    })
    const result = { value: 7 }
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const finish = () => {
      calls++
      wall = 500
      monotonic = 75
      return result
    }
    const target = action(
      asynchronous
        ? async () => {
            await wrap(gate)
            return finish()
          }
        : finish,
      'clock.execution',
    )
    let pending: unknown
    try {
      pending = context.start(() => target())
      if (asynchronous) {
        expect(calls).toBe(0)
        release()
        expect(await pending).toBe(result)
      } else expect(pending).toBe(result)
      await otel.flush()
      expect(calls).toBe(1)
      expect(wall).toBe(500)
      const spans = bodies.flatMap(parseSpans)
      expect(spans).toHaveLength(1)
      const span = spans[0]!
      expect(span.name).toBe('clock.execution')
      expect(BigInt(span.startTimeUnixNano)).toBe(1_000_000_000n)
      expect(BigInt(span.endTimeUnixNano)).toBe(1_025_000_000n)
      expect(
        BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano),
      ).toBe(25_000_000n)
      expect(otel.stats()).toMatchObject({
        active: 0,
        queued: 0,
        inFlight: 0,
        exported: 1,
        dropped: 0,
      })
    } finally {
      release()
      try {
        await pending
      } finally {
        otel.dispose()
        wallClock.mockRestore()
        monotonicClock.mockRestore()
      }
    }
  },
)
