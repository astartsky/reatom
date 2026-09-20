import { action, bind, context } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { parseSpans } from './test-helpers.ts'

test.each([false, true])(
  'exception capture does not invoke accessors (opt-in=%s)',
  async (capture: boolean) => {
    const bodies: string[] = []
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'error-capture',
      captureValues: capture ? {} : false,
      filter: (target) => target.name === 'capture.error',
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response(null)
      },
    })
    const error = new Error()
    let reads = 0
    for (const key of ['name', 'constructor', 'message', 'stack'])
      Object.defineProperty(error, key, {
        configurable: true,
        get() {
          reads++
          return 'accessor-private-sentinel'
        },
      })
    try {
      const target = run(() =>
        action(() => {
          throw error
        }, 'capture.error'),
      )
      let caught = false
      try {
        run(target)
      } catch (value) {
        caught = true
        expect(value).toBe(error)
      }
      expect(caught).toBe(true)
      await otel.flush()
      const spans = bodies.flatMap(parseSpans)
      expect(spans.map((span) => span.name)).toEqual(['capture.error'])
      expect(spans[0]!.events).toHaveLength(1)
      expect(spans[0]!.events[0]!.attributes).toEqual({
        'exception.type': 'Error',
      })
      expect(reads).toBe(0)
      expect(bodies.join('')).not.toContain('accessor-private-sentinel')
    } finally {
      otel.dispose()
    }
  },
)

test.each(['named', 'native'])(
  'default abort exports a fixed marker without its private reason (%s)',
  async (kind: string) => {
    const bodies: string[] = []
    const run = context.start(() => bind(<T>(callback: () => T) => callback()))
    const otel = reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName: 'error-capture',
      filter: (target) => target.name === 'capture.abort',
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response(null)
      },
    })
    const error =
      kind === 'native'
        ? new DOMException('abort-private-sentinel', 'AbortError')
        : Object.assign(new Error('abort-private-sentinel'), {
            name: 'AbortError',
          })
    try {
      const target = run(() =>
        action(() => {
          throw error
        }, 'capture.abort'),
      )
      let caught = false
      try {
        run(target)
      } catch (value) {
        caught = true
        expect(value).toBe(error)
      }
      expect(caught).toBe(true)
      await otel.flush()
      const spans = bodies.flatMap(parseSpans)
      expect(spans.map((span) => span.name)).toEqual(['capture.abort'])
      expect(spans[0]!.events).toEqual([])
      expect(spans[0]!.status).toBeUndefined()
      expect(spans[0]!.attributes).toEqual({ payload: '[AbortError]' })
      expect(bodies.join('')).not.toContain('abort-private-sentinel')
    } finally {
      otel.dispose()
    }
  },
)
