import type { SpanId } from './generateSpanId.ts'
import { generateSpanId } from './generateSpanId.ts'
import type { TraceId } from './generateTraceId.ts'
import { generateTraceId } from './generateTraceId.ts'

export type SpanContext = Readonly<{ traceId: TraceId; spanId: SpanId }>
export const ROOT_BOUNDARY = Symbol('OTel root boundary')
export type ContextSlot = SpanContext | typeof ROOT_BOUNDARY

export const createChildContext = (parent?: ContextSlot): SpanContext =>
  Object.freeze({
    traceId:
      parent && parent !== ROOT_BOUNDARY ? parent.traceId : generateTraceId(),
    spanId: generateSpanId(),
  })

export const createSpanContext = () => {
  let value: ContextSlot | undefined
  let disposed = false
  return {
    read: () => value,
    dispose: () => {
      disposed = true
      value = undefined
    },
    write: (next: ContextSlot) => {
      if (!disposed) value = next
    },
    save: () => {
      const saved = value
      return () => {
        if (!disposed) value = saved
      }
    },
    current: (): SpanContext | undefined =>
      value === ROOT_BOUNDARY ? undefined : value,
  }
}
