import { action, bind, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'

test('disposal during parameter capture releases admission before allocating IDs', async () => {
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  let idCallsAfterDispose = -1
  const redactions: string[] = []
  let calls = 0
  const output = { private: 'unchanged application value' }
  const bodies: string[] = []
  const random = vi.spyOn(crypto, 'getRandomValues')
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'capture-disposal',
    filter: (target) => target.name === 'capture-disposal.target',
    maxQueueSize: 1,
    maxBatchSize: 1,
    captureValues: {
      redact(key, value) {
        redactions.push(key)
        if (key === 'params') {
          otel.dispose()
          idCallsAfterDispose = random.mock.calls.length
        }
        return value
      },
    },
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  try {
    const target = action(() => {
      calls++
      return output
    }, 'capture-disposal.target')
    expect(run(target)).toBe(output)
    expect(calls).toBe(1)
    expect(redactions).toEqual(['params'])
    expect(idCallsAfterDispose).toBe(0)
    expect(random).not.toHaveBeenCalled()
    otel.dispose()
    await otel.flush()
    expect(bodies).toEqual([])
    expect(otel.stats()).toMatchObject({
      active: 0,
      queued: 0,
      inFlight: 0,
      exported: 0,
      dropped: 1,
      droppedByReason: { disposed: 1, observation: 0 },
    })
  } finally {
    otel.dispose()
    random.mockRestore()
  }
})
