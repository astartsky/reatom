import { atom, bind, computed, context, notify, peek } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'

test.each([false, true])(
  'startTrace preserves dependency tracking (disposed=%s)',
  (disposed: boolean) => {
    const source = atom(1, 'source')
    const { otel, run } = setupTraced()

    const values: number[] = []
    const unsubscribe: Array<() => void> = []
    try {
      let bodyCalls = 0
      const traced = computed(() => {
        bodyCalls++
        return otel.startTrace('calc', () => source())
      }, 'traced')
      if (disposed) otel.dispose()
      run(() => {
        values.push(traced())
        unsubscribe.push(traced.subscribe(() => values.push(traced())))
      })
      run(() => notify())
      expect(values).toEqual([1, 1])
      expect(bodyCalls).toBe(1)

      run(() => {
        source.set(2)
        notify()
        expect(traced()).toBe(2)
        expect(bodyCalls).toBe(2)
      })
      expect(values).toEqual([1, 1, 2])
    } finally {
      run(() => {
        unsubscribe.forEach((d) => d())
        notify()
      })
      otel.dispose()
    }
  },
)

function setupTraced() {
  const fetch = vi.fn(async () => new Response(null, { status: 200 }))
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'root-transparency',
    retry: { maxRetries: 0 },
    fetch,
  })
  const run = context.start(() => bind(<T>(callback: () => T) => callback()))
  return { otel, run }
}

test.each([false, true])(
  'root callback keeps self-write recomputation (traced=%s)',
  (traced: boolean) => {
    const source = atom(0, 'self.source')
    let calls = 0
    const body = () => {
      calls++
      const value = source()
      if (value === 0) source.set(1)
      return value
    }
    const derived = computed(() =>
      traced ? otel.startTrace('self', body) : body(),
    )
    const { otel, run } = setupTraced()
    const values: number[] = []
    let unsubscribe = () => {}
    try {
      run(() => {
        unsubscribe = derived.subscribe((value) => values.push(value))
        notify()
        expect(derived()).toBe(1)
        expect(calls).toBe(2)
        source.set(2)
        notify()
        expect(derived()).toBe(2)
      })
      expect(calls).toBe(3)
      expect(values).toEqual([1, 2])
    } finally {
      run(() => {
        unsubscribe()
        notify()
      })
      otel.dispose()
    }
  },
)

test.each([false, true])(
  'root callback preserves peek isolation (traced=%s)',
  (traced: boolean) => {
    const trigger = atom(0, 'peek.trigger')
    const source = atom(1, 'peek.source')
    let calls = 0
    const derived = computed(() => {
      calls++
      trigger()
      return peek(() => (traced ? otel.startTrace('peek', source) : source()))
    })
    const { otel, run } = setupTraced()
    const values: number[] = []
    let unsubscribe = () => {}
    try {
      run(() => {
        unsubscribe = derived.subscribe((value) => values.push(value))
        source.set(2)
        notify()
        expect(derived()).toBe(1)
        expect(calls).toBe(1)
        trigger.set(1)
        notify()
        expect(derived()).toBe(2)
      })
      expect(calls).toBe(2)
      expect(values).toEqual([1, 2])
    } finally {
      run(() => {
        unsubscribe()
        notify()
      })
      otel.dispose()
    }
  },
)

test.each([
  ['active', null],
  ['active', undefined],
  ['disposed', null],
  ['disposed', undefined],
] as const)(
  '%s adapter: startTrace callback throwing %s crosses the boundary exactly',
  (mode: 'active' | 'disposed', thrown: null | undefined) => {
    const { otel, run } = setupTraced()
    try {
      if (mode === 'disposed') otel.dispose()

      let calls = 0
      let caught: unknown
      let caughtFlag = false
      run(() => {
        try {
          otel.startTrace('throwing', () => {
            calls++
            throw thrown
          })
        } catch (error) {
          // The throw really crossed the boundary — without this the undefined
          // case would pass vacuously even if nothing was thrown.
          caughtFlag = true
          caught = error
        }
      })

      expect(calls).toBe(1)
      expect(caughtFlag).toBe(true)
      expect(caught).toBe(thrown)
    } finally {
      if (mode === 'active') otel.dispose()
    }
  },
)
