import { atom, bind, context, notify, withComputed } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans, type ParsedSpan } from './test-helpers.ts'

test.each([false, true])(
  'withComputed preserves raw behavior and observes each execution (late=%s)',
  async (late: boolean) => {
    let rawTransforms = 0,
      tracedTransforms = 0
    const rawNotifications: number[] = [],
      tracedNotifications: number[] = []
    // Construction before the factory makes this a real uninstrumented twin.
    const raw = atom(0, 'raw')
    const rawTransform = withComputed<typeof raw>((value) => {
      rawTransforms++
      return value + 1
    })
    if (!late) raw.extend(rawTransform)
    const spans: ParsedSpan[] = []
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'transforms-test',
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        spans.push(...parseSpans(String(init?.body)))
        return new Response(null)
      },
    })
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    let detachRaw = () => {},
      detachTraced = () => {}
    try {
      const traced = atom(0, 'traced')
      const tracedTransform = withComputed<typeof traced>((value) => {
        tracedTransforms++
        return value + 1
      })
      if (!late) traced.extend(tracedTransform)
      expect([rawTransforms, tracedTransforms]).toEqual([0, 0])
      run(() => {
        detachRaw = raw.subscribe((value) => rawNotifications.push(value))
        detachTraced = traced.subscribe((value) =>
          tracedNotifications.push(value),
        )
        notify()
      })
      expect([rawTransforms, tracedTransforms]).toEqual(late ? [0, 0] : [1, 1])
      if (late) {
        raw.extend(rawTransform)
        traced.extend(tracedTransform)
      }
      // A late transform does not eagerly execute or alter the existing cache.
      const initial = late ? 0 : 1
      run(() => {
        expect(raw()).toBe(initial)
        expect(traced()).toBe(initial)
      })
      await otel.flush()
      expect(spans.map((span) => span.name)).toEqual(late ? [] : ['traced'])
      const initialSpanCount = spans.length
      for (let write = 0; write < 2; write++) {
        const beforeTransforms = tracedTransforms
        const beforeSpans = spans.length
        run(() => {
          raw.set(5)
          traced.set(5)
          notify()
          expect(raw()).toBe(6)
          expect(traced()).toBe(6)
        })
        await otel.flush()
        // Empty-computed writes run the transform before and after the setter.
        // Two actual compute bodies plus one set are three executions.
        expect(rawTransforms).toBe(tracedTransforms)
        expect(tracedTransforms - beforeTransforms).toBe(2)
        expect(spans.length - beforeSpans).toBe(3)
        expect(rawNotifications).toEqual([initial, 6])
        expect(tracedNotifications).toEqual(rawNotifications)

        const afterWrite = spans.length
        const afterTransforms = tracedTransforms
        run(() => {
          expect(raw()).toBe(6)
          expect(traced()).toBe(6)
          expect(traced()).toBe(6)
        })
        await otel.flush()
        expect(spans.length).toBe(afterWrite)
        expect(tracedTransforms).toBe(afterTransforms)
      }
      expect(spans).toHaveLength(initialSpanCount + 6)
      expect(spans.every((span) => span.name === 'traced')).toBe(true)
      expect(otel.stats()).toMatchObject({
        active: 0,
        queued: 0,
        inFlight: 0,
        dropped: 0,
      })
    } finally {
      run(() => {
        detachTraced()
        detachRaw()
        notify()
      })
      otel.dispose()
    }
  },
)
