import { peek, STACK } from '@reatom/core'

let depth = 0
export const isObserving = () => depth !== 0

/** Suppress synchronous tracing without changing application dependencies. */
export const suppressTracing = <T>(callback: () => T): T => {
  depth++
  try {
    return callback()
  } finally {
    depth--
  }
}

/** Isolate dependency tracking and swallow telemetry callback failures. */
export const observe = <T>(callback: () => T): T | undefined => {
  try {
    return suppressTracing(() => (STACK.length ? peek(callback) : callback()))
  } catch {
    return undefined
  }
}
