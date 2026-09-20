import { peek, STACK } from '@reatom/core'

let depth = 0
export const isObserving = () => depth !== 0

/** Isolate dependency tracking and swallow telemetry callback failures. */
export const observe = <T>(callback: () => T): T | undefined => {
  depth++
  try {
    return STACK.length ? peek(callback) : callback()
  } catch {
    return undefined
  } finally {
    depth--
  }
}
