import { action, atom, bind, context, top, wrap } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { createChildContext, createSpanContext } from './spanContext.ts'

test.each(['action', 'atom'] as const)(
  'dispose inside begin-capture remains final for %s',
  async (kind: 'action' | 'atom') => {
    const baseline = context._continuationContextConsumers
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    const read = () => ({ frame: top(), record: top()._continuationContext })
    let frame: ReturnType<typeof top> | undefined
    let recordAfterDispose: ReturnType<typeof top>['_continuationContext']
    let recordInBody: ReturnType<typeof top>['_continuationContext']
    let callbacks: Array<typeof read> = []
    let beforeDispose = -1
    let afterDispose = -1
    let idCallsAfterDispose = -1
    let redactions = 0
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
          if (key === (kind === 'action' ? 'params' : 'prevState')) {
            redactions++
            frame = top()
            callbacks = [bind(read), wrap(read)]
            beforeDispose = context._continuationContextConsumers ?? 0
            otel.dispose()
            afterDispose = context._continuationContextConsumers ?? 0
            idCallsAfterDispose = random.mock.calls.length
            recordAfterDispose = frame._continuationContext
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
      createChildContext()
      expect(random.mock.calls).toHaveLength(2)
      const target = run(() => {
        const body = () => {
          calls++
          recordInBody = top()._continuationContext
          return output
        }
        return kind === 'action'
          ? action(body, 'capture-disposal.target')
          : atom(body, 'capture-disposal.target')
      })
      expect(run(() => target())).toBe(output)
      expect(calls).toBe(1)
      expect(redactions).toBe(1)
      expect(beforeDispose).toBe((baseline ?? 0) + 1)
      expect(afterDispose).toBe(baseline ?? 0)
      expect(idCallsAfterDispose).toBe(2)
      expect(random.mock.calls).toHaveLength(idCallsAfterDispose)
      expect(context._continuationContextConsumers ?? 0).toBe(baseline ?? 0)
      expect(recordAfterDispose).toBeDefined()
      expect(recordInBody).toBe(recordAfterDispose)
      expect(frame!._continuationContext).toBeUndefined()
      expect(callbacks).toHaveLength(2)
      for (const callback of callbacks)
        expect(run(callback)).toEqual({ frame, record: undefined })
      for (const preserve of [bind, wrap])
        expect(run(() => preserve(read)()).record).toBeUndefined()
      otel.dispose()
      expect(context._continuationContextConsumers ?? 0).toBe(baseline ?? 0)
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
      // Restore the test-owned global count even when a leaking mutant fails.
      context._continuationContextConsumers = baseline
    }
  },
)

test.each([false, true])(
  'disposed context storage cannot write or reacquire (previously active=%s)',
  (active: boolean) => {
    const baseline = context._continuationContextConsumers
    const storage = createSpanContext()
    try {
      context.start(() => {
        if (active) storage.write(createChildContext())
        const record = top()._continuationContext
        storage.dispose()
        storage.write(createChildContext())
        expect(context._continuationContextConsumers ?? 0).toBe(baseline ?? 0)
        expect(top()._continuationContext).toBe(record)
        storage.dispose()
        expect(context._continuationContextConsumers ?? 0).toBe(baseline ?? 0)
      })
    } finally {
      storage.dispose()
      context._continuationContextConsumers = baseline
    }
  },
)
