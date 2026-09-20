import { context, type Frame, STACK } from './atom'

const EMPTY = Object.freeze({})

/** Capture the supplied frame's effective integration context, never data pubs. */
export function captureContinuation(
  frame: Frame,
): Frame['_continuationContext'] {
  if (!context._continuationContextConsumers) return undefined
  if (frame._continuationContext) return frame._continuationContext
  // An explicit frame outside this stack has no dynamic ancestors here.
  for (let i = STACK.lastIndexOf(frame) - 1; i >= 0; i--) {
    const parent = STACK[i]!
    if (parent._continuationContext) return parent._continuationContext
  }
  return EMPTY
}

/** A complete record also preserves absent keys, including before first use. */
export function enterContinuation(
  frame: Frame,
  captured: Frame['_continuationContext'],
): () => void {
  const previous = frame._continuationContext
  frame._continuationContext = captured ?? EMPTY
  return () => {
    frame._continuationContext = previous
  }
}
