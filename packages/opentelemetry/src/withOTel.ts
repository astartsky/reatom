import type { AtomLike, Fn, GenericExt } from '@reatom/core'
import { isAction, withActionMiddleware } from '@reatom/core'

import type { SpanInput, SpanKind } from './buildSpan.ts'
import { MAX_RECORD_BYTES } from './buildSpan.ts'
import type { SpanEventInput } from './buildSpanEvent.ts'
import {
  type CaptureValuesOptions,
  createValueCapture,
} from './captureValues.ts'
import type { Reservation } from './createBatchQueue.ts'
import { errorData, exceptionType } from './errorMetadata.ts'
import { isObserving, observe } from './observation.ts'
import {
  createChildContext,
  createSpanContext,
  ROOT_BOUNDARY,
  type SpanContext,
} from './spanContext.ts'
import { toOtlpBytesValue } from './toOtlpBytesValue.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'

export interface WithOTelOptions {
  kind?: SpanKind
}

export interface CreateWithOTelInput {
  captureValues?: CaptureValuesOptions
  /** Admission precedes IDs/capture; rejected invocations still carry context. */
  reserveSpan: () => Reservation<SpanInput> | undefined
  /**
   * Checked before starting observation and at completion, before inspecting
   * user values. The adapter supplies its lifecycle state.
   */
  isActive: () => boolean
}

// Only owned, normalized snapshots reach JSON.stringify.
const stringifyCaptured = (value: OtlpAttrValue): string =>
  typeof value === 'string'
    ? value
    : JSON.stringify(value, (_, item) =>
        typeof item === 'bigint'
          ? String(item)
          : item instanceof Uint8Array
            ? toOtlpBytesValue(item).bytesValue
            : item,
      )

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

/** Actions use the existing middleware; context scopes are synchronous. */
export const createWithOTel = ({
  reserveSpan,
  isActive,
  captureValues = false,
}: CreateWithOTelInput) => {
  const storage = createSpanContext()
  const optionsByTarget = new WeakMap<AtomLike, WithOTelOptions>()

  const observeSpan = (
    name: string,
    options: WithOTelOptions,
    params: readonly unknown[],
    root = false,
  ): ((outcome: Outcome) => void) | undefined => {
    if (!isActive()) return
    if (root) storage.write(ROOT_BOUNDARY)
    const parent = storage.read()
    const reservation = observe(reserveSpan)
    if (!reservation) return
    if (name.length > MAX_RECORD_BYTES) {
      observe(() => reservation.cancel('oversized'))
      return
    }
    const span = observe(() => {
      const startTimeMs = Date.now()
      const startPerfMs = performance.now()
      const capture = captureValues
        ? createValueCapture(captureValues.redact)
        : undefined
      const captured = (key: string, value: unknown) =>
        stringifyCaptured(capture!.capture(key, value))
      const before: SpanInput['attributes'] = capture
        ? { params: captured('params', params) }
        : undefined
      // Redaction can dispose this adapter while the input is being captured.
      if (!isActive()) return
      const ctx = createChildContext(parent)
      storage.write(ctx)
      const nowMs = () => startTimeMs + (performance.now() - startPerfMs)
      const queueWith = (
        attributes: SpanInput['attributes'],
        status?: SpanInput['status'],
        events?: SpanInput['events'],
      ) =>
        reservation.commit({
          ...ctx,
          parentSpanId:
            parent && parent !== ROOT_BOUNDARY ? parent.spanId : undefined,
          name,
          kind: options.kind,
          startTimeMs,
          endTimeMs: nowMs(),
          attributes,
          status,
          events,
        })
      const queueErr = (error: unknown) => {
        const attributes: Record<string, OtlpAttrValue> = {
          'exception.type': exceptionType(error),
        }
        let message: string | undefined
        if (capture) {
          const value =
            error instanceof Error ? errorData(error, 'message') : error
          if (value !== undefined)
            attributes['exception.message'] = message = captured(
              'exception.message',
              value,
            )
          const stack = errorData(error, 'stack')
          if (stack !== undefined)
            attributes['exception.stacktrace'] = captured(
              'exception.stacktrace',
              stack,
            )
        }
        const event: SpanEventInput = {
          name: 'exception',
          timeMs: nowMs(),
          attributes,
        }
        queueWith(
          before,
          { code: 'error', ...(message === undefined ? {} : { message }) },
          [event],
        )
      }
      const emitErr = (error: unknown) => {
        if (error instanceof Promise) queueWith({ payload: '[Suspension]' })
        else if (exceptionType(error) === 'AbortError') {
          const reason = capture ? errorData(error, 'message') : undefined
          queueWith({
            payload:
              reason === undefined
                ? '[AbortError]'
                : captured('payload', reason),
          })
        } else queueErr(error)
      }
      const success = (value: unknown) =>
        queueWith(
          capture
            ? {
                ...before,
                payload: captured('payload', value),
              }
            : undefined,
        )
      return { success, emitErr }
    })
    if (!span) {
      observe(() => reservation.cancel('observation'))
      return
    }
    let completed = false
    const complete = (callback: () => void) => {
      if (completed) return
      completed = true
      observe(() => {
        if (!isActive()) {
          reservation.cancel('disposed')
          return
        }
        try {
          callback()
        } finally {
          reservation.cancel('observation')
        }
      })
    }
    const success = (value: unknown) =>
      complete(() => {
        span.success(value)
      })
    const failure = (error: unknown) => complete(() => span.emitErr(error))
    return (outcome) => {
      if (!outcome.ok) {
        failure(outcome.error)
        return
      }
      if (!isActive()) {
        complete(() => {})
        return
      }
      const attached = observe(() => {
        const result = outcome.value
        if (result instanceof Promise) {
          result.then(success, failure).catch(() => {})
        } else success(result)
        return true
      })
      // A hostile .then can register a callback and then throw. Close the
      // finalizer so that a later callback cannot inspect a dropped result.
      if (!attached) complete(() => {})
    }
  }

  // Restore on synchronous return, including when that return is a Promise.
  const begin = (...args: Parameters<typeof observeSpan>) => {
    if (!isActive()) return
    const restore = storage.save()
    let finish: ReturnType<typeof observeSpan>
    try {
      finish = observeSpan(...args)
    } catch (error) {
      restore()
      throw error
    }
    return (outcome: Outcome) => {
      try {
        finish?.(outcome)
      } finally {
        restore()
      }
    }
  }

  const invoke = <Result>(
    name: string,
    options: WithOTelOptions,
    params: readonly unknown[],
    callback: () => Result,
    root = false,
  ): Result => {
    if (!isActive() || isObserving()) return callback()
    const finish = begin(name, options, params, root)
    let result: Result
    try {
      result = callback()
    } catch (error) {
      finish?.({ ok: false, error })
      throw error
    }
    finish?.({ ok: true, value: result })
    return result
  }

  const install = <Target extends AtomLike>(
    target: Target,
    options: WithOTelOptions,
    enabled: boolean,
  ): Target => {
    if (!enabled || !isAction(target)) return target
    const existing = optionsByTarget.get(target)
    if (existing) {
      Object.assign(existing, options)
      return target
    }
    const settings = { ...options }
    optionsByTarget.set(target, settings)
    target.extend(
      withActionMiddleware(
        () =>
          (next: Fn, ...params: unknown[]) =>
            invoke(target.name, settings, params, () => next(...params)),
      ),
    )
    return target
  }
  const withOTel = (options: WithOTelOptions = {}): GenericExt<AtomLike> =>
    ((target: AtomLike) =>
      install(target, options, true)) as GenericExt<AtomLike>

  const rootOptions = {}

  return {
    dispose: () => {
      storage.dispose()
    },
    withOTel,
    auto: <Target extends AtomLike>(target: Target, enabled: boolean) =>
      install(target, {}, enabled),
    startTrace: <Result>(name: string, callback: () => Result): Result => {
      if (!isActive()) return callback()
      return invoke(name, rootOptions, [], callback, true)
    },
    withContext: <Result>(
      pair: SpanContext | undefined,
      callback: () => Result,
    ): Result => {
      if (!isActive()) return callback()
      const restore = storage.save()
      try {
        storage.write(
          pair === undefined
            ? ROOT_BOUNDARY
            : Object.freeze({ traceId: pair.traceId, spanId: pair.spanId }),
        )
        return callback()
      } finally {
        restore()
      }
    },
    getCurrentContext: () => (isActive() ? storage.current() : undefined),
  }
}
