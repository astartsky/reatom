import { context, named, STACK, top, variable } from '@reatom/core'

import type { SpanId } from './generateSpanId.ts'
import { generateSpanId } from './generateSpanId.ts'
import type { TraceId } from './generateTraceId.ts'
import { generateTraceId } from './generateTraceId.ts'

export type SpanContext = Readonly<{ traceId: TraceId; spanId: SpanId }>
export const ROOT_BOUNDARY = Symbol('OTel root boundary')
export type ContextSlot = SpanContext | typeof ROOT_BOUNDARY

export const isOTelInternal = (target: { name: string }): boolean =>
  target.name.startsWith('var#_reatomOtelContext#')

export const createChildContext = (parent?: ContextSlot): SpanContext =>
  Object.freeze({
    traceId:
      parent && parent !== ROOT_BOUNDARY ? parent.traceId : generateTraceId(),
    spanId: generateSpanId(),
  })

export const createSpanContext = () => {
  // Variable's helper actions also use this reserved, instance-unique name.
  let acquired = false
  let disposed = false
  const slot = variable<ContextSlot>(named('_reatomOtelContext'))
  const record = (from = STACK.length - 1) => {
    for (let i = from; i >= 0; i--) {
      const snapshot = STACK[i]!._continuationContext
      if (snapshot) return snapshot
    }
    return undefined
  }
  const read = (from?: number): ContextSlot | undefined =>
    record(from)?.[slot.name] as ContextSlot | undefined
  return {
    read,
    dispose: () => {
      disposed = true
      if (!acquired) return
      acquired = false
      context._continuationContextConsumers!--
    },
    write: (value: ContextSlot, frame = top()) => {
      if (disposed) return
      if (!acquired) {
        acquired = true
        context._continuationContextConsumers =
          (context._continuationContextConsumers ?? 0) + 1
      }
      frame._continuationContext = Object.freeze({
        ...record(),
        [slot.name]: value,
      })
    },
    save: (frame = top()) => {
      const snapshot = frame._continuationContext
      return () => {
        frame._continuationContext = snapshot
      }
    },
    current: (): SpanContext | undefined => {
      const value = read()
      return value === ROOT_BOUNDARY ? undefined : value
    },
  }
}
