import type { QueueOptions } from './queueOptions.ts'

export type DropReason =
  | 'capacity'
  | 'oversized'
  | 'disposed'
  | 'export'
  | 'timeout'
  | 'observation'

export interface BatchOutcome {
  exported: number
  beaconAccepted: number
  droppedByReason: Partial<Record<DropReason, number>>
}

export interface TelemetryStats {
  readonly active: number
  readonly queued: number
  readonly inFlight: number
  readonly exported: number
  readonly dropped: number
  /** Oversized includes both record limits and available unload byte budget. */
  readonly droppedByReason: Readonly<Record<DropReason, number>>
  readonly beaconAccepted: number
  readonly flushTimeouts: number
  readonly transportQuarantined: boolean
}

export interface Reservation<T> {
  commit(record: T): void
  cancel(reason: DropReason): void
}

export interface BatchLease<T> {
  readonly items: readonly T[]
  /** The first valid terminal outcome wins. */
  release(outcome: BatchOutcome): void
}

export interface BatchQueueInput<T> extends QueueOptions {
  send(lease: BatchLease<T>): void
  onError?: (error: unknown, items: readonly T[]) => void
  onFlushTimeout?: (unfinished: number) => void
  isQuarantined?: () => boolean
}

export interface BatchQueue<T> {
  reserve(): Reservation<T> | undefined
  flush(): Promise<void>
  takeForUnload(): BatchLease<T> | undefined
  stats(): TelemetryStats
  dispose(): void
}

const emptyDrops = (): Record<DropReason, number> => ({
  capacity: 0,
  oversized: 0,
  disposed: 0,
  export: 0,
  timeout: 0,
  observation: 0,
})

// Diagnostics must not break ownership transitions, including outside a frame.
const report = (callback: () => void) => {
  try {
    callback()
  } catch {
    // A diagnostic callback cannot interrupt the queue transition.
  }
}

/** Holds capacity until a reservation or its transport lease reaches an outcome. */
export const createBatchQueue = <T>(
  input: BatchQueueInput<T>,
): BatchQueue<T> => {
  interface Entry {
    state: 'active' | 'queued' | 'inFlight' | 'released'
    record?: T
  }
  interface Waiter {
    pending: Set<Entry>
    finish(): void
  }
  const entries = new Set<Entry>()
  const waiters = new Set<Waiter>()
  const queued: Entry[] = []
  const droppedByReason = emptyDrops()
  let active = 0,
    inFlight = 0,
    exported = 0,
    beaconAccepted = 0,
    flushTimeouts = 0
  let disposed = false
  let slot: BatchLease<T> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let draining = false
  let pumpScheduled = false

  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const settle = (entry: Entry) => {
    entry.state = 'released'
    entry.record = undefined
    entries.delete(entry)
    for (const waiter of waiters) {
      waiter.pending.delete(entry)
      if (waiter.pending.size === 0) waiter.finish()
    }
  }
  const schedulePump = () => {
    if (pumpScheduled || disposed) return
    pumpScheduled = true
    queueMicrotask(() => {
      pumpScheduled = false
      pump()
    })
  }
  const take = (selected: Entry[]): BatchLease<T> => {
    for (const entry of selected) entry.state = 'inFlight'
    inFlight += selected.length
    let released = false
    const items = selected.map((entry) => entry.record as T)
    const lease: BatchLease<T> = {
      items,
      release(outcome) {
        if (released) return
        const counts = [
          outcome.exported,
          outcome.beaconAccepted,
          ...Object.values(outcome.droppedByReason),
        ]
        if (
          counts.some((n) => !Number.isSafeInteger(n) || n < 0) ||
          counts.reduce((a, b) => a + b, 0) !== items.length ||
          Object.keys(outcome.droppedByReason).some(
            (key) => !Object.hasOwn(droppedByReason, key),
          )
        ) {
          throw new RangeError('Invalid batch outcome')
        }
        released = true
        exported += outcome.exported
        beaconAccepted += outcome.beaconAccepted
        for (const reason of Object.keys(
          outcome.droppedByReason,
        ) as DropReason[]) {
          droppedByReason[reason] += outcome.droppedByReason[reason]!
        }
        inFlight -= selected.length
        slot = undefined
        for (const entry of selected) settle(entry)
        schedulePump()
      },
    }
    slot = lease
    return lease
  }
  const pump = () => {
    if (disposed) return
    if (queued.length === 0) {
      draining = false
      clearTimer()
      return
    }
    const flushDemand = [...waiters].some((waiter) =>
      [...waiter.pending].some((entry) => entry.state === 'queued'),
    )
    if (
      !slot &&
      (draining || queued.length >= input.maxBatchSize || flushDemand)
    ) {
      clearTimer()
      const lease = take(queued.splice(0, input.maxBatchSize))
      if (!queued.length) draining = false
      try {
        input.send(lease)
      } catch (error) {
        lease.release({
          exported: 0,
          beaconAccepted: 0,
          droppedByReason: { export: lease.items.length },
        })
        report(() => input.onError?.(error, lease.items))
      }
    }
    if (queued.length && timer === undefined && !draining) {
      timer = setTimeout(() => {
        timer = undefined
        draining = true
        pump()
      }, input.batchInterval)
    }
  }

  return {
    reserve() {
      if (disposed) return
      if (entries.size >= input.maxQueueSize) {
        droppedByReason.capacity++
        return
      }
      const entry: Entry = { state: 'active' }
      entries.add(entry)
      active++
      return {
        commit(record) {
          if (entry.state !== 'active') return
          active--
          entry.record = record
          entry.state = 'queued'
          queued.push(entry)
          pump()
        },
        cancel(reason) {
          if (entry.state !== 'active') return
          active--
          droppedByReason[reason]++
          settle(entry)
        },
      }
    },
    flush() {
      const pending = new Set(
        [...entries].filter((entry) => entry.state !== 'active'),
      )
      if (disposed || pending.size === 0) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const waiter: Waiter = {
          pending,
          finish() {
            clearTimeout(deadline)
            waiters.delete(waiter)
            pending.clear()
            resolve()
          },
        }
        const deadline = setTimeout(() => {
          flushTimeouts++
          const unfinished = pending.size
          waiter.finish()
          report(() => input.onFlushTimeout?.(unfinished))
        }, input.exportTimeoutMs)
        waiters.add(waiter)
        pump()
      })
    },
    takeForUnload() {
      if (disposed || slot || !queued.length) return
      const lease = take(
        queued.splice(Math.max(0, queued.length - input.maxBatchSize)),
      )
      if (!queued.length) {
        draining = false
        clearTimer()
      }
      return lease
    },
    stats() {
      return Object.freeze({
        active,
        queued: queued.length,
        inFlight,
        exported,
        beaconAccepted,
        flushTimeouts,
        dropped: Object.values(droppedByReason).reduce((a, b) => a + b, 0),
        droppedByReason: Object.freeze({ ...droppedByReason }),
        transportQuarantined: input.isQuarantined?.() ?? false,
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
      queued.length = 0
      for (const entry of entries) {
        if (entry.state === 'inFlight') continue
        if (entry.state === 'active') active--
        droppedByReason.disposed++
        settle(entry)
      }
      for (const waiter of waiters) waiter.finish()
    },
  }
}
