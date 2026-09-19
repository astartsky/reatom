import { tracesUrl } from './tracesUrl.ts'

export interface FlushWithBeaconInput<T> {
  endpoint: string
  spans: readonly T[]
  buildPayload: (spans: readonly T[]) => unknown
  maxBeaconBytes?: number
  sendBeacon?: (url: string, data: BodyInit) => boolean
}

// Below the typical 64KB browser sendBeacon limit; leaves headroom for
// envelope overhead (resource, scope, payload wrapper).
const DEFAULT_MAX_BEACON_BYTES = 63_000

/**
 * Sends queued spans via `navigator.sendBeacon` during page unload.
 *
 * `sendBeacon` cannot carry custom headers (browser limitation) and caps
 * payload size near 64KB — so this drops the oldest spans in a loop until the
 * payload fits `maxBeaconBytes`. Newest spans win: those are closest to the
 * unload that triggered the flush.
 *
 * Returns the number selected by the byte limit and whether the browser
 * accepted them. Acceptance transfers ownership; delivery is not confirmed.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
 */
export const flushWithBeacon = <T>(
  input: FlushWithBeaconInput<T>,
): { accepted: boolean; selectedCount: number } => {
  if (input.spans.length === 0) return { accepted: true, selectedCount: 0 }

  // SSR / JSDOM / older browsers may have `document` but no `navigator.sendBeacon`.
  // Bail out as a delivery failure rather than throwing inside an unload handler.
  const fallback =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon.bind(navigator)
      : undefined
  const sendBeacon = input.sendBeacon ?? fallback
  if (!sendBeacon) return { accepted: false, selectedCount: input.spans.length }
  const maxBytes = input.maxBeaconBytes ?? DEFAULT_MAX_BEACON_BYTES
  const url = tracesUrl(input.endpoint)

  // Binary search: linear scan would re-stringify O(N) shrinking payloads
  // inside the browser's tight unload budget.
  let lo = 0
  let hi = input.spans.length - 1
  let bestBlob: Blob | undefined
  let selectedCount = 0
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const body = JSON.stringify(input.buildPayload(input.spans.slice(mid)))
    const blob = new Blob([body], { type: 'application/json' })
    if (blob.size <= maxBytes) {
      bestBlob = blob
      selectedCount = input.spans.length - mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  if (!bestBlob) return { accepted: false, selectedCount: 0 }
  try {
    return { accepted: sendBeacon(url, bestBlob), selectedCount }
  } catch {
    return { accepted: false, selectedCount }
  }
}
