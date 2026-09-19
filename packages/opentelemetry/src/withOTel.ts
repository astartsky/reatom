import type { AtomLike, Fn, GenericExt } from '@reatom/core'
import {
  bind,
  isAbort,
  isAction,
  STACK,
  top,
  withActionMiddleware,
  withMiddleware,
} from '@reatom/core'

import type { SpanInput, SpanKind } from './buildSpan.ts'
import type { SpanEventInput } from './buildSpanEvent.ts'
import type { SpanId } from './generateSpanId.ts'
import { generateSpanId } from './generateSpanId.ts'
import type { TraceId } from './generateTraceId.ts'
import { generateTraceId } from './generateTraceId.ts'
import { observe } from './observation.ts'
import { serialize } from './serialize.ts'
import { spanIdVar } from './spanIdVar.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'
import { traceIdVar } from './traceIdVar.ts'

export interface WithOTelOptions {
  kind?: SpanKind
}

export interface CreateWithOTelInput {
  /**
   * Receives a fully-formed SpanInput when an instrumented atom/action
   * finishes.
   */
  queueSpan: (span: SpanInput) => void
  /**
   * Checked before starting observation and at completion, before inspecting
   * user values. The adapter supplies its lifecycle state.
   */
  isActive: () => boolean
}

interface SpanContext {
  traceId: TraceId
  parentTraceId: TraceId | undefined
  spanId: SpanId
  parentSpanId: SpanId | undefined
}

// Read trace context from the caller frame on the JS stack — top()'s
// pubs[0] is null on atom-set / computed-read paths when OTel runs (the
// caller link is wired later by computedMiddleware on the write branch
// only, or by cacheMiddleware on read AFTER next()). Action middleware
// hand-rolls pubs[0] before OTel runs, which is why action -> action
// inheritance worked under the old top()-based read.
const enterSpan = (): SpanContext => {
  const callerFrame = STACK[STACK.length - 2]
  const parentTraceId = callerFrame ? traceIdVar.get(callerFrame) : undefined
  const traceId = parentTraceId ?? generateTraceId()
  const parentSpanId =
    parentTraceId && callerFrame ? spanIdVar.get(callerFrame) : undefined
  const spanId = generateSpanId()
  return { traceId, parentTraceId, spanId, parentSpanId }
}

// Reatom abort and thrown-Promise (suspension) are control flow, not errors:
// they get an ok-status span with a payload note instead of an error span.
const isControlFlow = (error: unknown): boolean =>
  isAbort(error) || error instanceof Promise

const controlFlowAttributes = (
  error: unknown,
): Record<string, string> | undefined => {
  if (isAbort(error)) return { payload: serialize(error) }
  if (error instanceof Promise) return { payload: '[Suspension]' }
  return undefined
}

// Per OTel semantic conventions for exceptions: an error span carries a span
// event named "exception" with exception.type / .message / .stacktrace /
// .escaped. Auto-instrumentation always rethrows, so `escaped` is always true.
// https://opentelemetry.io/docs/specs/semconv/exceptions/exception-spans/
const exceptionEvent = (error: unknown, timeMs: number): SpanEventInput => {
  const isErr = error instanceof Error
  const attributes: Record<string, OtlpAttrValue> = {
    'exception.type': isErr ? error.constructor.name : 'Error',
    'exception.message': isErr ? error.message : serialize(error),
    'exception.escaped': true,
  }
  if (isErr && error.stack) attributes['exception.stacktrace'] = error.stack
  return { name: 'exception', timeMs, attributes }
}

/**
 * Idempotent: applying twice to the same target merges options (later override
 * wins) but installs the middleware only once, so a global
 * `addGlobalExtension(withOTel())` plus a local `withOTel({ kind })` override
 * doesn't double-emit.
 */
export const createWithOTel = ({
  queueSpan,
  isActive,
}: CreateWithOTelInput) => {
  const optionsByTarget = new WeakMap<AtomLike, WithOTelOptions>()
  const installed = new WeakSet<AtomLike>()

  return (options: WithOTelOptions = {}): GenericExt<AtomLike> => {
    return ((target: AtomLike): AtomLike => {
      let opts = optionsByTarget.get(target)
      if (opts) Object.assign(opts, options)
      else optionsByTarget.set(target, (opts = { ...options }))

      if (installed.has(target)) return target

      installed.add(target)

      // Per OTel API spec, STATUS_CODE_OK SHOULD only be set by the
      // application — instrumentation leaves success spans unset so a user's
      // explicit `setStatus(OK)` retains its signal. Errors and explicit
      // failures emit `error`; AbortError/Suspension are control flow and
      // route through `emitErr`'s `cf` branch (status unset, payload note).
      const startMiddleware = () => {
        // Anchor wall clock once and measure duration via a monotonic source
        // so NTP steps cannot produce negative endTime - startTime.
        const startTimeMs = Date.now()
        const startPerfMs = performance.now()
        const ctx = enterSpan()

        spanIdVar.set(ctx.spanId)
        if (!ctx.parentTraceId) traceIdVar.set(ctx.traceId)

        // Derived from the same monotonic anchor as endTimeMs so an event
        // timestamp can never sit outside [startTimeMs, endTimeMs] — which a
        // raw Date.now() would do under an NTP step.
        const nowMs = () => startTimeMs + (performance.now() - startPerfMs)

        const queueWith = (
          attributes: SpanInput['attributes'],
          status?: SpanInput['status'],
          events?: SpanInput['events'],
        ) =>
          queueSpan({
            traceId: ctx.traceId,
            spanId: ctx.spanId,
            parentSpanId: ctx.parentSpanId,
            name: target.name,
            kind: opts.kind,
            startTimeMs,
            endTimeMs: nowMs(),
            attributes,
            status,
            events,
          })

        const queueErr = (error: unknown) =>
          queueWith(undefined, { code: 'error', message: serialize(error) }, [
            exceptionEvent(error, nowMs()),
          ])

        const emitErr = (error: unknown) => {
          if (isControlFlow(error)) {
            queueWith(controlFlowAttributes(error))
            return
          }
          queueErr(error)
        }

        return { queueWith, queueErr, emitErr }
      }

      const actionTarget = isAction(target)
      const middleware =
        () =>
        (next: Fn, ...params: any[]) => {
          if (!isActive()) return next(...params)

          const span = observe(startMiddleware)
          const prevState = actionTarget ? undefined : top().state
          let completed = false
          const complete = (callback: () => void) => {
            if (completed) return
            completed = true
            if (isActive()) observe(callback)
          }
          const success = (value: unknown) =>
            complete(() => {
              span?.queueWith(
                actionTarget
                  ? { params: serialize(params), payload: serialize(value) }
                  : {
                      prevState: serialize(prevState),
                      nextState: serialize(value),
                    },
              )
            })
          const failure = (error: unknown, async: boolean) =>
            complete(() => {
              if (!actionTarget && !async) {
                // Preserve atom-set error semantics and suspension control flow.
                if (!(error instanceof Promise)) span?.queueErr(error)
              } else span?.emitErr(error)
            })

          let result
          try {
            result = next(...params)
          } catch (error) {
            if (span) failure(error, false)
            throw error
          }

          if (span && isActive())
            observe(() => {
              if (result instanceof Promise) {
                result
                  .then(
                    bind(success),
                    bind((error: unknown) => failure(error, true)),
                  )
                  .catch(() => {})
              } else success(result)
            })
          return result
        }

      if (isAction(target)) {
        return target.extend(withActionMiddleware(middleware))
      }
      return target.extend(withMiddleware(middleware))
    }) as GenericExt<AtomLike>
  }
}
