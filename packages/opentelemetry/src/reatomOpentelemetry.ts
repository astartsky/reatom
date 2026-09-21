import type { AtomLike, Ext } from '@reatom/core'
import {
  addGlobalExtension,
  EXTENSIONS,
  isAbort,
  isAction,
  isSkip,
  removeItem,
  STACK,
} from '@reatom/core'

import { buildExportPayload, buildResource } from './buildExportPayload.ts'
import type { OtlpSpan, SpanInput } from './buildSpan.ts'
import { buildSpan, MAX_RECORD_BYTES } from './buildSpan.ts'
import { createValueCapture } from './captureValues.ts'
import type { Reservation, TelemetryStats } from './createBatchQueue.ts'
import { createBatchQueue } from './createBatchQueue.ts'
import { createExportWorker } from './createExportWorker.ts'
import { flushWithBeacon } from './flushWithBeacon.ts'
import { hexFromBytes } from './hexFromBytes.ts'
import { isObserving, observe } from './observation.ts'
import { parseExportResponse } from './parseExportResponse.ts'
import { resolveQueueOptions } from './queueOptions.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import type { RetryWithBackoffInput } from './retryWithBackoff.ts'
import { retryWithBackoff } from './retryWithBackoff.ts'
import { selectUnloadBatch } from './selectUnloadBatch.ts'
import { sendTraces } from './sendTraces.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'
import { availableUnloadBytes, reserveUnloadBytes } from './unloadBudget.ts'
import { createWithOTel } from './withOTel.ts'

const encoder = new TextEncoder()

const resourceSnapshot = (
  capture: ReturnType<typeof createValueCapture>,
  value: Record<string, OtlpAttrValue>,
): Record<string, OtlpAttrValue> => {
  const snapshot = capture.capture('resource', value)
  if (
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    snapshot instanceof Uint8Array
  )
    throw new TypeError('Invalid resource attributes')
  return snapshot
}

// Capture has already bounded, copied and removed cycles from these values.
// Sort object keys for grouping while preserving distinctions between types.
const stableKey = (value: OtlpAttrValue | null | undefined): string => {
  if (value === null || value === undefined) return 'x'
  if (typeof value === 'string') return 's' + JSON.stringify(value)
  if (typeof value === 'number') return 'n' + String(value)
  if (typeof value === 'bigint') return 'B' + value.toString()
  if (typeof value === 'boolean') return value ? 'b1' : 'b0'
  if (value instanceof Uint8Array) return 'U' + hexFromBytes(value)
  if (Array.isArray(value)) return 'A[' + value.map(stableKey).join(',') + ']'
  return (
    'O{' +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ':' + stableKey(value[key]))
      .join(',') +
    '}'
  )
}

export interface ReatomOpentelemetryInput {
  endpoint: string
  serviceName: string
  /**
   * Construction-time defaults. For per-trace runtime overrides set
   * `resourceAttributesVar`.
   */
  resourceAttributes?: Record<string, OtlpAttrValue>
  /**
   * Capture bounded snapshots of application values. Disabled by default; `{}`
   * opts in. A redaction failure discards the complete span.
   */
  captureValues?: false | { redact?: (key: string, value: unknown) => unknown }
  headers?: Record<string, string>
  /**
   * Selects automatic action spans. Filtered actions retain the surrounding
   * synchronous scope. Ordinary core bind/wrap do not capture this scope.
   */
  filter?: (target: AtomLike) => boolean
  batchInterval?: number
  maxBatchSize?: number
  maxQueueSize?: number
  /** Budget for each batch export and, separately, each flush caller. */
  exportTimeoutMs?: number
  /**
   * Opt-in to `navigator.sendBeacon` for unload-time delivery. Default:
   * `false`.
   *
   * Beacon cannot carry custom auth headers. Both transports are subject to
   * CORS and a shared browser keepalive budget; delivery is best effort.
   * Accepted beacon bytes remain charged for this document's lifetime.
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
  withOTel: ReturnType<typeof createWithOTel>['withOTel']
  /** Start a separate root in the current store; preserve callback outcome. */
  startTrace: ReturnType<typeof createWithOTel>['startTrace']
  /** Current immutable pair, or undefined outside a synchronous trace scope. */
  getCurrentContext: ReturnType<typeof createWithOTel>['getCurrentContext']
  /** Install a saved pair (or explicit absence) only for this synchronous call. */
  withContext: ReturnType<typeof createWithOTel>['withContext']
  /** Wait for finished records present at invocation, up to exportTimeoutMs. */
  flush: () => Promise<void>
  /** Immutable snapshot of capacity, delivery and losses. */
  stats: () => TelemetryStats
  /** Stop new observation and batching; request abort of in-flight export. */
  dispose: () => void
}

/**
 * Install tracing before creating application actions. Values are excluded
 * unless captureValues is enabled; existing targets require local withOTel.
 * Flush before disposal when delivery should be attempted at shutdown.
 */
export const reatomOpentelemetry = (
  input: ReatomOpentelemetryInput,
): ReatomOpentelemetry => {
  const queueOptions = resolveQueueOptions(input)
  const pageDocument = typeof document === 'undefined' ? undefined : document
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
  const resourceAttributes = observe(() => {
    const capture = createValueCapture()
    const serviceName = capture.capture('service.name', input.serviceName)
    return {
      'service.name': serviceName,
      ...resourceSnapshot(capture, input.resourceAttributes ?? {}),
    }
  })
  const version = input.version ?? ''

  // Each queue item carries its own resourceAttributesVar snapshot so a
  // span dropped at maxQueueSize cannot taint the batch made of survivors.
  // Items are grouped at flush time so spans with different resource
  // attributes go to distinct resourceSpans entries — required by OTLP and
  // critical when traces from multiple environments share one batch window.
  type QueueItem = {
    span: OtlpSpan
    resourceAttributes: Record<string, OtlpAttrValue>
  }
  const groupItemsByResource = (
    items: readonly QueueItem[],
  ): Array<{
    resourceAttributes: Record<string, OtlpAttrValue>
    spans: OtlpSpan[]
  }> => {
    const groups = new Map<
      string,
      { resourceAttributes: Record<string, OtlpAttrValue>; spans: OtlpSpan[] }
    >()
    for (const item of items) {
      const key = stableKey(item.resourceAttributes)
      let group = groups.get(key)
      if (!group) {
        group = {
          resourceAttributes: item.resourceAttributes,
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
  const selectUnload = (items: readonly QueueItem[]) =>
    selectUnloadBatch({
      items,
      maxBytes: availableUnloadBytes(pageDocument!),
      // One complete ResourceSpans group per record allows exact linear sizing.
      encode: (item) => JSON.stringify(payload([item]).resourceSpans[0]),
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
    send: async (items, { signal, deadline, keepalive, excludeOversized }) => {
      let credit: ReturnType<typeof reserveUnloadBytes> | undefined
      let keptCount = items.length
      let body: string | undefined
      try {
        if (keepalive) {
          const selected = selectUnload(items)
          keptCount = selected.keptCount
          excludeOversized(selected.droppedCount)
          if (keptCount === 0)
            return { exported: 0, beaconAccepted: 0, droppedByReason: {} }
          body = selected.body
          credit = reserveUnloadBytes(
            pageDocument!,
            encoder.encode(body).length,
          )
        }
        const data = body === undefined ? payload(items) : undefined
        const response = await retryWithBackoff({
          ...input.retry,
          ...(keepalive ? { maxRetries: 0 } : {}),
          signal,
          deadline,
          send: () =>
            sendTraces({
              endpoint: input.endpoint,
              payload: data,
              body,
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
        // A body read remains part of the transport and its byte reservation.
        const outcome = parseExportResponse(await response.text(), keptCount)
        if (outcome.rejected || outcome.errorMessage)
          observe(() =>
            console.warn(
              `[@reatom/opentelemetry] OTLP export to ${input.endpoint}: partialSuccess rejected ${outcome.rejected} spans${outcome.errorMessage ? ': ' + outcome.errorMessage : ''}`,
            ),
          )
        return {
          exported: outcome.accepted,
          beaconAccepted: 0,
          droppedByReason: outcome.rejected ? { export: outcome.rejected } : {},
        }
      } finally {
        credit?.release()
      }
    },
  })

  const queue = createBatchQueue<QueueItem>({
    ...queueOptions,
    send: (lease) => {
      // A full batch can be committed before the observed execution settles.
      // Transport wrappers may read application state; run them after capture.
      if (isObserving()) queueMicrotask(() => worker.send(lease))
      else worker.send(lease)
    },
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
    // Capture ambient Resource at admission; async completion retains no Frame.
    let resources: Record<string, OtlpAttrValue>
    try {
      if (!resourceAttributes) throw new Error('Invalid Resource')
      const override = STACK.length ? resourceAttributesVar.get() : undefined
      resources =
        override === undefined
          ? resourceAttributes
          : {
              ...resourceAttributes,
              ...resourceSnapshot(createValueCapture(), override),
            }
    } catch {
      reservation.cancel('observation')
      return
    }
    return {
      commit: (span) => {
        if (!resourceAttributes) {
          reservation.cancel('observation')
          return
        }
        // Bound metadata before encoding; application graphs were already
        // normalized by capture. The batch envelope has a separate budget.
        if (
          span.name.length > MAX_RECORD_BYTES ||
          version.length > MAX_RECORD_BYTES
        ) {
          reservation.cancel('oversized')
          return
        }
        const record = { span: buildSpan(span), resourceAttributes: resources }
        const size = encoder.encode(
          JSON.stringify({
            span: record.span,
            resource: buildResource(resources),
            scope: { name: '@reatom/opentelemetry', version },
          }),
        ).length
        if (size > MAX_RECORD_BYTES) reservation.cancel('oversized')
        else reservation.commit(record)
      },
      cancel: reservation.cancel,
    }
  }
  const tracing = createWithOTel({
    reserveSpan,
    isActive: () => !disposed,
    captureValues: input.captureValues,
  })

  const globalExt: Ext = (target) => {
    if (!isAction(target) || isObserving()) return target
    return tracing.auto(
      target,
      !isSkip(target) &&
        (input.filter ? observe(() => !!input.filter!(target)) === true : true),
    )
  }
  addGlobalExtension(globalExt)

  const flushNow = () => {
    if (disposed || !pageDocument) return
    const lease = queue.takeForUnload()
    if (!lease) return
    if (input.useBeacon !== true) {
      worker.send(lease, true)
      return
    }
    let credit: ReturnType<typeof reserveUnloadBytes> | undefined
    let keptCount = lease.items.length
    let excluded = 0
    try {
      const selected = selectUnload(lease.items)
      keptCount = selected.keptCount
      excluded = selected.droppedCount
      if (keptCount === 0) {
        lease.release({
          exported: 0,
          beaconAccepted: 0,
          droppedByReason: { oversized: excluded },
        })
        return
      }
      credit = reserveUnloadBytes(
        pageDocument,
        encoder.encode(selected.body).length,
      )
      const endpoint = input.endpoint
      const sendBeacon = input.sendBeacon
      if (disposed) {
        lease.release({
          exported: 0,
          beaconAccepted: 0,
          droppedByReason: { disposed: keptCount, oversized: excluded },
        })
        return
      }
      const accepted = flushWithBeacon({
        endpoint,
        body: selected.body,
        sendBeacon,
      })
      if (accepted) credit.acceptBeacon()
      lease.release({
        exported: 0,
        beaconAccepted: accepted ? keptCount : 0,
        droppedByReason: {
          oversized: excluded,
          export: accepted ? 0 : keptCount,
        },
      })
      if (!accepted)
        logExportError(new Error('beacon delivery failed'), lease.items)
    } catch (error) {
      lease.release({
        exported: 0,
        beaconAccepted: 0,
        droppedByReason: {
          oversized: excluded,
          [disposed ? 'disposed' : 'export']: keptCount,
        },
      })
      logExportError(error, lease.items)
    } finally {
      credit?.release()
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
    withOTel: tracing.withOTel,
    startTrace: tracing.startTrace,
    getCurrentContext: tracing.getCurrentContext,
    withContext: tracing.withContext,
    stats: queue.stats,
    flush: queue.flush,
    dispose: () => {
      if (disposed) return
      disposed = true
      tracing.dispose()
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
