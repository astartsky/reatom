import { tracesUrl } from './tracesUrl.ts'

export interface FlushWithBeaconInput {
  endpoint: string
  /** Complete JSON already selected against the shared document byte budget. */
  body: string
  sendBeacon?: (url: string, data: BodyInit) => boolean
}

/** Browser acceptance transfers ownership, without confirming delivery. */
export const flushWithBeacon = (input: FlushWithBeaconInput): boolean => {
  if (!input.body) return true
  const fallback =
    typeof navigator !== 'undefined' &&
    typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon.bind(navigator)
      : undefined
  const sendBeacon = input.sendBeacon ?? fallback
  if (!sendBeacon) return false
  try {
    return sendBeacon(
      tracesUrl(input.endpoint),
      new Blob([input.body], { type: 'application/json' }),
    )
  } catch {
    return false
  }
}
