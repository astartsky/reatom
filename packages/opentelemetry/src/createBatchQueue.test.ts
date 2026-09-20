import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { BatchLease, BatchQueueInput } from './createBatchQueue.ts'
import { createBatchQueue } from './createBatchQueue.ts'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const setup = (options: Partial<BatchQueueInput<number>> = {}) => {
  const sent: BatchLease<number>[] = []
  const send = vi.fn((lease: BatchLease<number>) => {
    sent.push(lease)
  })
  const queue = createBatchQueue<number>({
    batchInterval: 1000,
    maxBatchSize: 3,
    maxQueueSize: 10,
    exportTimeoutMs: 30_000,
    send,
    ...options,
  })
  const push = (value: number) => queue.reserve()?.commit(value)
  return { queue, sent, send, push }
}
const success = (lease: BatchLease<number>) =>
  lease.release({
    exported: lease.items.length,
    beaconAccepted: 0,
    droppedByReason: {},
  })

test('interval and batch size trigger bounded leases', async () => {
  const { queue, sent, push } = setup()
  push(1)
  push(2)
  expect(sent).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(sent.map((x) => x.items)).toEqual([[1, 2]])
  success(sent[0]!)
  push(3)
  push(4)
  push(5)
  expect(sent.map((x) => x.items)).toEqual([
    [1, 2],
    [3, 4, 5],
  ])
  success(sent[1]!)
  expect(queue.stats()).toMatchObject({
    active: 0,
    queued: 0,
    inFlight: 0,
    exported: 5,
  })
  queue.dispose()
  expect(vi.getTimerCount()).toBe(0)
})

test('capacity includes active, queued and leased records', async () => {
  const { queue, sent, push } = setup({ maxQueueSize: 2, maxBatchSize: 1 })
  const active = queue.reserve()!
  push(1)
  for (let i = 0; i < 10; i++) expect(queue.reserve()).toBeUndefined()
  expect(queue.stats()).toMatchObject({
    active: 1,
    queued: 0,
    inFlight: 1,
    dropped: 10,
    droppedByReason: { capacity: 10 },
  })
  active.commit(2)
  expect(sent).toHaveLength(1)
  expect(queue.stats()).toMatchObject({ active: 0, queued: 1, inFlight: 1 })
  success(sent[0]!)
  await Promise.resolve()
  expect(sent.map((x) => x.items)).toEqual([[1], [2]])
  success(sent[1]!)
  expect(queue.stats()).toMatchObject({
    active: 0,
    queued: 0,
    inFlight: 0,
    exported: 2,
    dropped: 10,
  })
  queue.dispose()
})

test('flush excludes active executions and ignores later records', async () => {
  const { queue, sent, push } = setup()
  const active = queue.reserve()!
  push(1)
  let finished = false
  const flush = queue.flush().then(() => {
    finished = true
  })
  push(2)
  active.commit(3)
  expect(sent.map((x) => x.items)).toEqual([[1]])
  success(sent[0]!)
  await flush
  expect(finished).toBe(true)
  expect(queue.stats()).toMatchObject({ queued: 2, exported: 1 })
  queue.dispose()
})

test('each flush has its own wait deadline without releasing a lease', async () => {
  const onFlushTimeout = vi.fn()
  const { queue, sent, push } = setup({ exportTimeoutMs: 30, onFlushTimeout })
  push(1)
  const a = queue.flush()
  await vi.advanceTimersByTimeAsync(20)
  let bDone = false
  const b = queue.flush().then(() => {
    bDone = true
  })
  await vi.advanceTimersByTimeAsync(10)
  await a
  expect(bDone).toBe(false)
  expect(onFlushTimeout).toHaveBeenCalledWith(1)
  expect(queue.stats()).toMatchObject({
    inFlight: 1,
    dropped: 0,
    flushTimeouts: 1,
  })
  success(sent[0]!)
  await b
  expect(queue.stats()).toMatchObject({
    inFlight: 0,
    exported: 1,
    flushTimeouts: 1,
  })
  queue.dispose()
})

test('dispose releases active and queued, but holds the live transport lease', async () => {
  const { queue, sent, push } = setup({ maxBatchSize: 1 })
  push(1)
  const active = queue.reserve()!
  push(2)
  const flush = queue.flush()
  queue.dispose()
  await flush
  expect(queue.stats()).toMatchObject({
    active: 0,
    queued: 0,
    inFlight: 1,
    dropped: 2,
    droppedByReason: { disposed: 2 },
  })
  active.commit(3)
  active.cancel('observation')
  queue.dispose()
  expect(queue.reserve()).toBeUndefined()
  expect(queue.stats().dropped).toBe(2)
  sent[0]!.release({
    exported: 0,
    beaconAccepted: 0,
    droppedByReason: { disposed: 1 },
  })
  expect(queue.stats()).toMatchObject({
    inFlight: 0,
    dropped: 3,
    droppedByReason: { disposed: 3 },
  })
  await vi.runAllTimersAsync()
  expect(sent).toHaveLength(1)
})

test('mixed terminal outcomes are validated and counted exactly once', () => {
  const { queue, sent, push } = setup({ maxBatchSize: 10 })
  for (let i = 0; i < 10; i++) push(i)
  const lease = sent[0]!
  const before = queue.stats()
  expect(() =>
    lease.release({ exported: 10, beaconAccepted: 1, droppedByReason: {} }),
  ).toThrow(RangeError)
  expect(() =>
    lease.release({
      exported: 9.5,
      beaconAccepted: 0,
      droppedByReason: { export: 0.5 },
    }),
  ).toThrow(RangeError)
  expect(queue.stats()).toEqual(before)
  lease.release({
    exported: 5,
    beaconAccepted: 0,
    droppedByReason: { oversized: 2, export: 3 },
  })
  success(lease)
  expect(queue.stats()).toMatchObject({
    inFlight: 0,
    exported: 5,
    dropped: 5,
    droppedByReason: { oversized: 2, export: 3 },
  })
  expect(before.inFlight).toBe(10)
  expect(before.droppedByReason.export).toBe(0)
  queue.dispose()
})

test('cancels and beacon handoff have distinct terminal accounting', () => {
  const { queue, push } = setup()
  const failed = queue.reserve()!
  failed.cancel('observation')
  failed.cancel('oversized')
  failed.commit(0)
  push(1)
  push(2)
  const lease = queue.takeForUnload()!
  expect(lease.items).toEqual([1, 2])
  lease.release({
    exported: 0,
    beaconAccepted: 1,
    droppedByReason: { oversized: 1 },
  })
  expect(queue.stats()).toMatchObject({
    exported: 0,
    beaconAccepted: 1,
    dropped: 2,
    droppedByReason: { observation: 1, oversized: 1 },
  })
  expect(queue.takeForUnload()).toBeUndefined()
  queue.dispose()
})

test('unload takes only the newest bounded batch, and never steals a busy slot', async () => {
  const { queue, sent, push } = setup({ maxBatchSize: 2 })
  push(0)
  push(1)
  for (let i = 2; i <= 6; i++) push(i)
  expect(queue.takeForUnload()).toBeUndefined()
  expect(queue.stats().queued).toBe(5)
  success(sent[0]!)
  const unload = queue.takeForUnload()!
  expect(unload.items).toEqual([5, 6])
  expect(queue.stats()).toMatchObject({ queued: 3, inFlight: 2 })
  await Promise.resolve()
  expect(sent).toHaveLength(1)
  success(unload)
  await Promise.resolve()
  expect(sent[1]!.items).toEqual([2, 3])
  queue.dispose()
  success(sent[1]!)
})

test('synchronous worker and diagnostic failures do not escape or leak slots', async () => {
  const onError = vi.fn(() => {
    throw new Error('logger failure')
  })
  const { queue, push, send } = setup({
    send: () => {
      throw new Error('worker failure')
    },
    onError,
  })
  push(1)
  await expect(queue.flush()).resolves.toBeUndefined()
  expect(onError).toHaveBeenCalledTimes(1)
  expect(queue.stats()).toMatchObject({
    queued: 0,
    inFlight: 0,
    dropped: 1,
    droppedByReason: { export: 1 },
  })
  expect(send).not.toHaveBeenCalled()
  queue.dispose()
})
