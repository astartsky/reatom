import { context, peek, STACK } from '@reatom/core'

/** Observer failures and reads must not affect the application's computation. */
export const observe = <T>(callback: () => T): T | undefined => {
  const previous = context._observation
  context._observation = true
  try {
    // Transport callbacks can run outside a Reatom invocation.
    return STACK.length ? peek(callback) : callback()
  } catch {
    return undefined
  } finally {
    context._observation = previous
  }
}
