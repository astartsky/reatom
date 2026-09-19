import { peek, STACK } from '@reatom/core'

/** Observer failures and reads must not affect the application's computation. */
export const observe = <T>(callback: () => T): T | undefined => {
  try {
    // Transport callbacks can run outside a Reatom invocation.
    return STACK.length ? peek(callback) : callback()
  } catch {
    return undefined
  }
}
