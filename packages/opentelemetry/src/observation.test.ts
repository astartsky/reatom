import { atom, computed, context, withConnectHook, wrap } from '@reatom/core'
import { expect, test } from 'vitest'

import { observe } from './observation.ts'

test('nested observation keeps the outer restriction and does not retain it across await', async () => {
  await context.start(async () => {
    let calls = 0
    let refusals = 0
    const lazy = atom(() => ++calls)
    const gate = Promise.withResolvers<void>()
    const pending = observe(() => {
      observe(() => {
        throw new Error('nested observation')
      })
      try {
        lazy()
      } catch {
        refusals++
      }
      try {
        context.start(() => lazy())
      } catch {
        refusals++
      }
      return (async () => {
        await wrap(gate.promise)
        return lazy()
      })()
    })
    try {
      expect(refusals).toBe(2)
      expect(calls).toBe(0)
      gate.resolve()
      expect(await pending).toBe(1)
      expect(calls).toBe(1)
    } finally {
      gate.resolve()
      await pending
    }
  })
})

test.each([false, true])(
  'observation restores dependency tracking after callback (throws=%s)',
  async (throwing: boolean) => {
    await context.start(async () => {
      const source = atom(1, 'source')
      let connections = 0
      const telemetry = atom(10, 'telemetry').extend(
        withConnectHook(() => {
          connections++
        }),
      )
      let rawCalls = 0,
        observedCalls = 0,
        observerCalls = 0
      const raw = computed(() => {
        rawCalls++
        return source() * 2
      }, 'raw')
      const derived = computed(() => {
        observedCalls++
        observe(() => {
          observerCalls++
          telemetry()
          if (throwing) throw new Error('observer')
        })
        return source() * 2
      }, 'observed')
      const rawValues: number[] = [],
        observedValues: number[] = []
      const offRaw = raw.subscribe((value) => rawValues.push(value))
      const offObserved = derived.subscribe((value) =>
        observedValues.push(value),
      )
      try {
        await wrap(Promise.resolve())
        telemetry.set(11)
        await wrap(Promise.resolve())
        expect(derived()).toBe(2)
        expect(rawCalls).toBe(1)
        expect(observedCalls).toBe(1)
        expect(observerCalls).toBe(1)
        expect(connections).toBe(0)
        source.set(2)
        await wrap(Promise.resolve())
        expect(raw()).toBe(4)
        expect(derived()).toBe(4)
        expect(rawCalls).toBe(2)
        expect(observedCalls).toBe(2)
        expect(observerCalls).toBe(2)
        expect(rawValues).toEqual([2, 4])
        expect(observedValues).toEqual([2, 4])
      } finally {
        offObserved()
        offRaw()
      }
    })
  },
)
