import { action, atom, computed, context } from '@reatom/core'
import { expect, test, vi } from 'vitest'

import type { ReatomOpentelemetry } from './reatomOpentelemetry.ts'
import { reatomOpentelemetry } from './reatomOpentelemetry.ts'

const ENDPOINT = 'https://otel.test'

interface WireSpan {
  name: string
  traceId: string
  spanId: string
  parentSpanId?: string
}
interface WirePayload {
  resourceSpans: Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>
}

interface Setup {
  otel: ReatomOpentelemetry
  fetchMock: ReturnType<typeof vi.fn>
  exported: WirePayload[]
}
const setup = () => {
  const exported: WirePayload[] = []
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    exported.push(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 200 })
  })
  const otel = reatomOpentelemetry({
    endpoint: ENDPOINT,
    serviceName: 'guard-test',
    fetch: fetchMock,
  })
  return { otel, fetchMock, exported }
}

/** Count Date.now/performance.now ticks during fn() only. */
const withClockCount = <T>(
  fn: () => T,
): { result: T; ticks: number; ids: number } => {
  const dateNow = vi.spyOn(Date, 'now')
  const perfNow = vi.spyOn(performance, 'now')
  const random = vi.spyOn(crypto, 'getRandomValues')
  dateNow.mockClear()
  perfNow.mockClear()
  try {
    return {
      result: fn(),
      ticks: dateNow.mock.calls.length + perfNow.mock.calls.length,
      ids: random.mock.calls.length,
    }
  } finally {
    dateNow.mockRestore()
    perfNow.mockRestore()
    random.mockRestore()
  }
}

test('positive control: active instrumentation observes clocks, capture and export', async () => {
  let reads = 0
  const payload = {
    get value() {
      reads++
      return 'secret'
    },
  }
  const { otel, fetchMock } = setup()
  try {
    const work = action(() => payload, 'work')
    context.start(() => {
      const run = withClockCount(() => work())
      expect(run.result).toBe(payload)
      // Positive control: with the adapter active, removal of instrumentation
      // cannot pass — clocks tick and capture reads the payload.
      expect(run.ticks).toBeGreaterThan(0)
      expect(run.ids).toBeGreaterThan(0)
      expect(reads).toBe(1)
    })
    await otel.flush()
    expect(fetchMock).toHaveBeenCalled()
  } finally {
    otel.dispose()
    vi.restoreAllMocks()
  }
})

test('after dispose: action call and atom.set preserve identity/state with zero clock, capture, export', async () => {
  let reads = 0
  const payload = {
    get value() {
      reads++
      return 'secret'
    },
  }
  const { otel, fetchMock } = setup()
  try {
    const work = action(() => payload, 'workAfterDispose')
    const counter = atom(0, 'guardCounter')
    context.start(() => {
      expect(work()).toBe(payload)
      expect(counter.set(1)).toBe(1)
    })
    await otel.flush()
    expect(fetchMock).toHaveBeenCalled()

    otel.dispose()
    fetchMock.mockClear()
    reads = 0

    context.start(() => {
      const run = withClockCount(() => work())
      // Return identity preserved...
      expect(run.result).toBe(payload)
      // ...but the observer is inert: no clock observation, no capture read.
      expect(run.ticks).toBe(0)
      expect(run.ids).toBe(0)
      expect(reads).toBe(0)
      // Atom write preserves state without observer activity.
      const update = withClockCount(() => counter.set(2))
      expect(update.result).toBe(2)
      expect(update.ticks).toBe(0)
      expect(update.ids).toBe(0)
    })
    await otel.flush()
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    otel.dispose()
    vi.restoreAllMocks()
  }
})

for (const kind of ['action', 'computed'] as const) {
  for (const reject of [false, true]) {
    test(`${kind}: ${reject ? 'rejection' : 'fulfillment'} after disposal does not inspect or enqueue`, async () => {
      const { otel, fetchMock } = setup()
      let reads = 0
      const value = {
        get secret() {
          reads++
          return 'sentinel'
        },
      }
      let finish!: (value: unknown) => void
      const original = new Promise<unknown>((resolve, fail) => {
        finish = reject ? fail : resolve
      })
      const outcome = original.then(
        (result) => ({ ok: true, value: result }),
        (error) => ({ ok: false, value: error }),
      )
      try {
        const target =
          kind === 'action'
            ? action(() => original, 'pending')
            : computed(() => original, 'pending')
        // Start while active so completion, rather than the entry guard, is tested.
        context.start(() => {
          const start = withClockCount(() => target())
          expect(start.result).toBe(original)
          expect(start.ticks).toBeGreaterThan(0)
          expect(start.ids).toBeGreaterThan(0)
        })
        otel.dispose()
        finish(value)
        const settled = await outcome
        await Promise.resolve()
        expect(settled.ok).toBe(!reject)
        expect(settled.value).toBe(value)
        expect(reads).toBe(0)
        await otel.flush()
        expect(fetchMock).not.toHaveBeenCalled()
      } finally {
        otel.dispose()
      }
    })
  }
}

test('after dispose: sync throw keeps error identity without error-field getter read', async () => {
  let reads = 0
  class Boom {
    get message() {
      reads++
      return 'boom'
    }
  }
  const { otel, fetchMock } = setup()
  try {
    const boom = new Boom()
    const fail = action(() => {
      throw boom
    }, 'failAfterDispose')

    context.start(() => {
      expect(() => fail()).toThrow()
    })
    await otel.flush()

    otel.dispose()
    fetchMock.mockClear()
    reads = 0

    let thrown: unknown
    context.start(() => {
      const run = withClockCount(() => {
        try {
          fail()
          return 'no-throw'
        } catch (e) {
          thrown = e
          return 'thrown'
        }
      })
      expect(run.result).toBe('thrown')
      expect(thrown).toBe(boom)
      expect(run.ticks).toBe(0)
      expect(run.ids).toBe(0)
    })
    expect(reads).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  } finally {
    otel.dispose()
    vi.restoreAllMocks()
  }
})

test('dispose -> new adapter -> same targets: exported child parents to the NEW parent, no old IDs', async () => {
  const collect = (payloads: WirePayload[]): WireSpan[] =>
    payloads.flatMap((p) =>
      p.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans)),
    )
  const a1 = setup()
  let a2: Setup | undefined
  try {
    const parent = action(() => {
      child()
    }, 'reparent')
    const child = action(() => 1, 'rechild')

    context.start(() => {
      parent()
    })
    await a1.otel.flush()
    const oldSpans = collect(a1.exported)
    expect(oldSpans.map((s) => s.name).sort()).toEqual(['rechild', 'reparent'])
    const oldIds = new Set(oldSpans.map((s) => s.spanId))
    expect(oldIds.size).toBe(2)

    a1.otel.dispose()

    a2 = setup()
    parent.extend(a2.otel.withOTel())
    child.extend(a2.otel.withOTel())
    context.start(() => {
      parent()
    })
    await a2.otel.flush()
    const newSpans = collect(a2.exported)
    const newParent = newSpans.find((s) => s.name === 'reparent')
    const newChild = newSpans.find((s) => s.name === 'rechild')
    expect(newSpans).toHaveLength(2)
    expect(newParent).toBeDefined()
    expect(newChild).toBeDefined()
    // Fresh IDs only: nothing from the disposed wrapper reappears.
    expect(oldIds.has(newParent!.spanId)).toBe(false)
    expect(oldIds.has(newChild!.spanId)).toBe(false)
    // Exact parent-child relationship through the NEW wrapper.
    expect(newChild!.parentSpanId).toBe(newParent!.spanId)
    expect(newChild!.traceId).toBe(newParent!.traceId)
  } finally {
    a1.otel.dispose()
    a2?.otel.dispose()
    vi.restoreAllMocks()
  }
})
