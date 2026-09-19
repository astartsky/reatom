import type {
  BatchLease,
  BatchOutcome,
  DropReason,
} from './createBatchQueue.ts'
import { ExportTimeoutError } from './retryWithBackoff.ts'

export interface ExportState {
  signal: AbortSignal
  deadline: number
  keepalive: boolean
}

export interface ExportWorkerInput<T> {
  exportTimeoutMs: number
  send(items: readonly T[], state: ExportState): Promise<BatchOutcome>
  onError?: (error: unknown, items: readonly T[]) => void
  onQuarantine?: (count: number) => void
}

const dropped = (reason: DropReason, count: number): BatchOutcome => ({
  exported: 0,
  beaconAccepted: 0,
  droppedByReason: { [reason]: count },
})
const report = (callback: () => void) => {
  try {
    callback()
  } catch {}
}

/** A deadline requests abort; only transport settlement releases the lease. */
export const createExportWorker = <T>(input: ExportWorkerInput<T>) => {
  let disposed = false
  let current:
    | { stop(reason: 'timeout' | 'disposed'): void; stopped: boolean }
    | undefined
  return {
    isQuarantined: () => current?.stopped ?? false,
    send(lease: BatchLease<T>, keepalive = false): void {
      if (disposed) {
        lease.release(dropped('disposed', lease.items.length))
        return
      }
      if (current) throw new Error('OTLP transport slot is already occupied')
      const controller = new AbortController()
      const deadline = Date.now() + input.exportTimeoutMs
      let terminal: 'timeout' | 'disposed' | undefined
      let quarantineTimer: ReturnType<typeof setTimeout> | undefined
      const state = {
        stopped: false,
        stop(reason: 'timeout' | 'disposed') {
          if (terminal) return
          terminal = reason
          state.stopped = true
          controller.abort(
            reason === 'timeout'
              ? new ExportTimeoutError()
              : new DOMException('Adapter disposed', 'AbortError'),
          )
          // Allow normal abort rejection/body cleanup to settle before warning.
          quarantineTimer = setTimeout(() => {
            if (current === state)
              report(() => input.onQuarantine?.(lease.items.length))
          }, 0)
        },
      }
      current = state
      const timer = setTimeout(
        () => state.stop('timeout'),
        input.exportTimeoutMs,
      )
      void (async () => {
        let outcome: BatchOutcome
        let failure: unknown
        let failed = false
        try {
          outcome = await input.send(lease.items, {
            signal: controller.signal,
            deadline,
            keepalive,
          })
        } catch (error) {
          failure = error
          failed = true
          let reason: DropReason = 'export'
          report(() => {
            if (error instanceof ExportTimeoutError) reason = 'timeout'
          })
          outcome = dropped(reason, lease.items.length)
        }
        clearTimeout(timer)
        if (quarantineTimer !== undefined) clearTimeout(quarantineTimer)
        current = undefined
        if (terminal) outcome = dropped(terminal, lease.items.length)
        try {
          lease.release(outcome)
        } catch (error) {
          failure = error
          failed = true
          lease.release(dropped('export', lease.items.length))
        }
        if (failed && terminal !== 'disposed')
          report(() => input.onError?.(failure, lease.items))
      })()
    },
    dispose() {
      disposed = true
      current?.stop('disposed')
    },
  }
}
