import type { AtomLike, Ext } from '@reatom/core'
import {
  addGlobalExtension,
  EXTENSIONS,
  isAbort,
  merge,
  removeItem,
} from '@reatom/core'

import { buildExportPayload } from './buildExportPayload.ts'
import type { OtlpSpan, SpanInput } from './buildSpan.ts'
import { buildSpan } from './buildSpan.ts'
import type { Reservation, TelemetryStats } from './createBatchQueue.ts'
import { createBatchQueue } from './createBatchQueue.ts'
import { createExportWorker } from './createExportWorker.ts'
import { flushWithBeacon } from './flushWithBeacon.ts'
import { hexFromBytes } from './hexFromBytes.ts'
import { observe } from './observation.ts'
import { resolveQueueOptions } from './queueOptions.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import type { RetryWithBackoffInput } from './retryWithBackoff.ts'
import { retryWithBackoff } from './retryWithBackoff.ts'
import { sendTraces } from './sendTraces.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'
import { createWithOTel } from './withOTel.ts'

// Type-aware stable serializer for resource-attribute grouping. JSON.stringify
// is unsafe here: it throws on bigint and emits non-canonical "{0:1,1:2,...}"
// for Uint8Array, conflating distinct byte sequences and crashing the flush.
// Ancestor-stack cycle detection mirrors toOtlpValue so a self-referencing
// attribute crashes neither the wire payload nor the grouping pass.
const stableKey = (
  value: OtlpAttrValue | null | undefined,
  seen?: WeakSet<object>,
): string => {
  if (value === null || value === undefined) return 'x'
  if (typeof value === 'string') return 's' + JSON.stringify(value)
  if (typeof value === 'number') return 'n' + String(value)
  if (typeof value === 'bigint') return 'B' + value.toString()
  if (typeof value === 'boolean') return value ? 'b1' : 'b0'
  if (value instanceof Uint8Array) return 'U' + hexFromBytes(value)
  seen ??= new WeakSet()
  if (Array.isArray(value)) {
    if (seen.has(value)) return 'C'
    seen.add(value)
    const result = 'A[' + value.map((v) => stableKey(v, seen)).join(',') + ']'
    seen.delete(value)
    return result
  }
  if (seen.has(value)) return 'C'
  seen.add(value)
  const keys = Object.keys(value).sort()
  const result =
    'O{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableKey(value[k], seen))
      .join(',') +
    '}'
  seen.delete(value)
  return result
}

export interface ReatomOpentelemetryInput {
  endpoint: string
  serviceName: string
  /**
   * Construction-time defaults. For per-trace runtime overrides set
   * `resourceAttributesVar`.
   */
  resourceAttributes?: Record<string, OtlpAttrValue>
  headers?: Record<string, string>
  /** Auto-instrumentation predicate. Truthy = instrument, falsy = skip. */
  filter?: (target: AtomLike) => boolean
  batchInterval?: number
  maxBatchSize?: number
  maxQueueSize?: number
  /** Budget for each batch export and, separately, each flush caller. */
  exportTimeoutMs?: number
  maxBeaconBytes?: number
  /**
   * Opt-in to `navigator.sendBeacon` for unload-time delivery. Default:
   * `false`.
   *
   * Beacon can NOT be used with collectors that need custom auth headers, and
   * because OTLP/JSON triggers a CORS preflight that browsers cannot run during
   * page unload, beacon will silently drop spans on any cross-origin endpoint.
   * The default transport is `fetch({ keepalive: true })`, which the browser
   * holds open past page teardown without preflight blocking.
   *
   * Only enable this for same-origin collectors that don't need auth.
   */
  useBeacon?: boolean
  /**
   * Tune the retry behavior of OTLP exports. Defaults follow the OTLP spec
   * recommendation: 3 retries, 1s base, 30s cap, full jitter.
   */
  retry?: Pick<
    RetryWithBackoffInput,
    'maxRetries' | 'baseDelayMs' | 'maxDelayMs'
  >
  /**
   * Instrumentation scope version emitted on every batch. Recommended: pass
   * your app or library version so collectors can distinguish releases.
   * Defaults to empty string (OTLP-valid but groups all batches under one
   * "@reatom/opentelemetry@" bucket on the collector side).
   */
  version?: string
  /** Internal — injection point for tests. */
  fetch?: typeof globalThis.fetch
  /** Internal — injection point for tests. */
  sendBeacon?: (url: string, data: BodyInit) => boolean
}

export interface ReatomOpentelemetry {
  withOTel: ReturnType<typeof createWithOTel>
  /** Wait for finished records present at invocation, up to exportTimeoutMs. */
  flush: () => Promise<void>
  /** Immutable snapshot of capacity, delivery and losses. */
  stats: () => TelemetryStats
  /** Unregister the global extension, stop timers, remove unload listener. */
  dispose: () => void
}

export const reatomOpentelemetry = (
  input: ReatomOpentelemetryInput,
): ReatomOpentelemetry => {
  const queueOptions = resolveQueueOptions(input)
  // OTel mandate: a tracer must never escalate. Log once, move on.
  // Aborts after dispose() are expected — gate at the single sink so
  // every call site (queue.onError, keepalive .catch) inherits it.
  // `dropped` lets ops correlate failure pressure with traffic — a 1-span
  // drop and a 100-span drop look identical without it.
  const logExportError = (error: unknown, dropped?: readonly unknown[]) =>
    observe(() => {
      if (isAbort(error)) return
      const detail = dropped ? ` (dropped ${dropped.length} spans)` : ''
      console.warn(
        `[@reatom/opentelemetry] OTLP export to ${input.endpoint} failed${detail}:`,
        error,
      )
    })
  const resourceAttributes: Record<string, OtlpAttrValue> = merge(
    { 'service.name': input.serviceName },
    input.resourceAttributes,
  )
  const version = input.version ?? ''

  // Each queue item carries its own resourceAttributesVar snapshot so a
  // span dropped at maxQueueSize cannot taint the batch made of survivors.
  // Items are grouped at flush time so spans with different resource
  // attributes go to distinct resourceSpans entries — required by OTLP and
  // critical when traces from multiple environments share one batch window.
  type QueueItem = {
    span: OtlpSpan
    resourceAttributes?: Record<string, OtlpAttrValue>
  }
  const groupItemsByResource = (
    items: readonly QueueItem[],
  ): Array<{
    resourceAttributes: Record<string, OtlpAttrValue>
    spans: OtlpSpan[]
  }> => {
    if (!items.some((i) => i.resourceAttributes)) {
      return [{ resourceAttributes, spans: items.map((i) => i.span) }]
    }
    const keyOf = (override?: Record<string, OtlpAttrValue>) =>
      stableKey({ ...resourceAttributes, ...override })
    const groups = new Map<
      string,
      { resourceAttributes: Record<string, OtlpAttrValue>; spans: OtlpSpan[] }
    >()
    for (const item of items) {
      const key = keyOf(item.resourceAttributes)
      let group = groups.get(key)
      if (!group) {
        group = {
          resourceAttributes: {
            ...resourceAttributes,
            ...item.resourceAttributes,
          },
          spans: [],
        }
        groups.set(key, group)
      }
      group.spans.push(item.span)
    }
    return [...groups.values()]
  }

  const payload = (items: readonly QueueItem[]) =>
    buildExportPayload({
      groups: groupItemsByResource(items).map((group) => ({
        ...group,
        version,
      })),
    })
  const worker = createExportWorker<QueueItem>({
    exportTimeoutMs: queueOptions.exportTimeoutMs,
    onError: logExportError,
    onQuarantine: (count) =>
      observe(() =>
        console.warn(
          `[@reatom/opentelemetry] transport did not settle after abort; holding ${count} records`,
        ),
      ),
    send: async (items, { signal, deadline, keepalive }) => {
      const body = payload(items)
      const response = await retryWithBackoff({
        ...input.retry,
        ...(keepalive ? { maxRetries: 0 } : {}),
        signal,
        deadline,
        send: () =>
          sendTraces({
            endpoint: input.endpoint,
            payload: body,
            headers: input.headers,
            fetch: input.fetch,
            signal,
            keepalive,
          }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`.trimEnd(),
        )
      }
      // A failed body read is an export failure, never an empty success.
      const text = await response.text()
      let parsed:
        | { partialSuccess?: { rejectedSpans?: number; errorMessage?: string } }
        | undefined
      try {
        if (text) parsed = JSON.parse(text)
      } catch {}
      const ps = parsed?.partialSuccess
      const rejected =
        typeof ps?.rejectedSpans === 'number' ? ps.rejectedSpans : 0
      if (
        !Number.isSafeInteger(rejected) ||
        rejected < 0 ||
        rejected > items.length
      ) {
        throw new Error('Invalid OTLP rejectedSpans')
      }
      if (rejected)
        observe(() =>
          console.warn(
            `[@reatom/opentelemetry] OTLP export to ${input.endpoint}: partialSuccess rejected ${rejected} spans${ps?.errorMessage ? ': ' + ps.errorMessage : ''}`,
          ),
        )
      return {
        exported: items.length - rejected,
        beaconAccepted: 0,
        droppedByReason: rejected ? { export: rejected } : {},
      }
    },
  })
  const queue = createBatchQueue<QueueItem>({
    ...queueOptions,
    send: worker.send,
    onError: logExportError,
    isQuarantined: worker.isQuarantined,
    onFlushTimeout: (unfinished) =>
      observe(() =>
        console.warn(
          `[@reatom/opentelemetry] flush_timeout: ${unfinished} records unfinished`,
        ),
      ),
  })
  let disposed = false
  const reserveSpan = (): Reservation<SpanInput> | undefined => {
    const reservation = queue.reserve()
    if (!reservation) return
    return {
      commit: (span) =>
        reservation.commit({
          span: buildSpan(span),
          resourceAttributes: resourceAttributesVar.get(),
        }),
      cancel: reservation.cancel,
      skip: reservation.skip,
    }
  }
  const withOTel = createWithOTel({ reserveSpan, isActive: () => !disposed })

  const globalExt: Ext = (target) => {
    if (input.filter && !input.filter(target)) return target
    return target.extend(withOTel())
  }
  addGlobalExtension(globalExt)

  const flushNow = () => {
    if (disposed) return
    const lease = queue.takeForUnload()
    if (!lease) return
    if (input.useBeacon !== true) {
      worker.send(lease, true)
      return
    }
    try {
      const result = flushWithBeacon({
        endpoint: input.endpoint,
        spans: lease.items,
        buildPayload: payload,
        maxBeaconBytes: input.maxBeaconBytes,
        sendBeacon: input.sendBeacon,
      })
      lease.release({
        exported: 0,
        beaconAccepted: result.accepted ? result.selectedCount : 0,
        droppedByReason: {
          oversized: lease.items.length - result.selectedCount,
          export: result.accepted ? 0 : result.selectedCount,
        },
      })
      if (!result.accepted)
        logExportError(new Error('beacon delivery failed'), lease.items)
    } catch (error) {
      lease.release({
        exported: 0,
        beaconAccepted: 0,
        droppedByReason: { export: lease.items.length },
      })
      logExportError(error, lease.items)
    }
  }

  const onVisibilityChange = () => {
    if (
      typeof document !== 'undefined' &&
      document.visibilityState === 'hidden'
    ) {
      flushNow()
    }
  }
  // iOS Safari fires `pagehide` without flipping visibilityState during
  // bf-cache transitions, so this handler must NOT gate on visibility.
  const onPageHide = flushNow

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', onPageHide)
  }

  return {
    withOTel,
    stats: queue.stats,
    flush: queue.flush,
    dispose: () => {
      if (disposed) return
      disposed = true
      queue.dispose()
      worker.dispose()
      removeItem(EXTENSIONS, globalExt)
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('pagehide', onPageHide)
      }
    },
  }
}
