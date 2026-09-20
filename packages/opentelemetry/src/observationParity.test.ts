import {
  action,
  atom,
  bind,
  computed,
  context,
  isConnected,
  notify,
} from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

test.each(['size', 'timer', 'flush'] as const)(
  'transport can read its bound computed when dispatched by %s',
  async (trigger: 'size' | 'timer' | 'flush') => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    const token = run(() => computed(() => 'token-7'))
    expect(run(token)).toBe('token-7')
    const sent: Array<{ token: string; names: string[] }> = []
    const fetch: typeof globalThis.fetch = run(() =>
      bind(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const authorization = token()
        sent.push({
          token: authorization,
          names: parseSpans(init?.body).map((span) => span.name),
        })
        return new Response(null)
      }),
    )
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'transport-observation',
      maxBatchSize: trigger === 'size' ? 1 : 10,
      batchInterval: 10,
      retry: { maxRetries: 0 },
      fetch,
    })
    try {
      expect(run(() => action(() => 7, 'transport.target')())).toBe(7)
      const flush = trigger === 'flush' ? otel.flush() : undefined
      await vi.advanceTimersByTimeAsync(trigger === 'timer' ? 10 : 0)
      await flush
      await otel.flush()
      expect(sent).toEqual([{ token: 'token-7', names: ['transport.target'] }])
      expect(otel.stats()).toMatchObject({
        exported: 1,
        dropped: 0,
        inFlight: 0,
      })
    } finally {
      otel.dispose()
      warn.mockRestore()
      vi.useRealTimers()
    }
  },
)

test('dispose prevents a deferred transport from starting and releases its lease', async () => {
  const fetch = vi.fn(async () => new Response(null))
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'transport-dispose',
    maxBatchSize: 1,
    fetch,
  })
  try {
    context.start(() => action(() => 7, 'transport.dispose')())
    otel.dispose()
    await Promise.resolve()
    await otel.flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(otel.stats()).toMatchObject({
      inFlight: 0,
      exported: 0,
      droppedByReason: { disposed: 1 },
    })
  } finally {
    otel.dispose()
  }
})

test.each(['action', 'root', 'async'] as const)(
  'capture does not initialize application state through result getters (%s)',
  async (mode: 'action' | 'root' | 'async') => {
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    let phase = 0
    let calls = 0
    let getterCalls = 0
    let requests = 0
    const bodies: string[] = []
    const lazy = run(() =>
      atom(() => {
        calls++
        return phase
      }, 'capture-late.lazy'),
    )
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'capture-late',
      captureValues: {},
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        requests++
        bodies.push(String(init?.body))
        return new Response(null)
      },
    })
    const value = {
      get value() {
        getterCalls++
        return lazy()
      },
    }
    try {
      const result = run(() => {
        if (mode === 'root')
          return otel.startTrace('capture-late.root', () => value)
        const target = action(
          () => (mode === 'async' ? Promise.resolve(value) : value),
          'capture-late.action',
        )
        return target()
      })
      expect(await result).toBe(value)
      phase = 1
      expect(run(() => lazy())).toBe(1)
      expect(calls).toBe(1)
      expect(getterCalls).toBe(0)
      await otel.flush()
      expect(requests).toBe(1)
      expect(bodies.flatMap(parseSpans)[0]!.attributes.payload).toBe(
        '{"value":"[Skipped]"}',
      )
    } finally {
      otel.dispose()
    }
  },
)

test.each([false, true])(
  'capture preserves connection-dependent application results (traced=%s)',
  async (traced: boolean) => {
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    let armed = false
    const { trigger, transient, reader } = run(() => {
      const trigger = atom(0, 'capture-parity.trigger')
      const transient = atom(3, 'capture-parity.transient')
      const reader = computed(() => {
        const value = trigger()
        if (!armed) return -1
        if (value !== 0) {
          transient()
          trigger.set(0)
          return -1
        }
        return isConnected(transient) ? 1 : 0
      }, 'capture-parity.reader')
      return { trigger, transient, reader }
    })
    let requests = 0
    const otel = traced
      ? reatomOpentelemetry({
          endpoint: 'https://collector.invalid',
          serviceName: 'capture-parity',
          captureValues: {},
          retry: { maxRetries: 0 },
          fetch: async () => {
            requests++
            return new Response(null)
          },
        })
      : undefined
    try {
      run(() => {
        const source = action(
          () => ({
            get value() {
              return reader()
            },
          }),
          'capture-parity.source',
        )
        const unsubscribe = reader.subscribe(() => {})
        try {
          notify()
          armed = true
          trigger.set(1)
          source()
          expect(reader()).toBe(1)
          expect(isConnected(transient)).toBe(false)
        } finally {
          unsubscribe()
          notify()
        }
        expect(isConnected(trigger)).toBe(false)
      })
      await otel?.flush()
      expect(requests).toBe(traced ? 1 : 0)
    } finally {
      otel?.dispose()
    }
  },
)
