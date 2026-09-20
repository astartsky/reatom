import type { AtomLike, AtomMeta, Fn, GenericExt } from '@reatom/core'
import { bind, isAction, STACK, withActionMiddleware } from '@reatom/core'

import type { SpanInput, SpanKind } from './buildSpan.ts'
import type { SpanEventInput } from './buildSpanEvent.ts'
import {
  type CaptureValuesOptions,
  createValueCapture,
} from './captureValues.ts'
import { createLinkCollector, type LinkExecution } from './collectLinks.ts'
import type { Reservation } from './createBatchQueue.ts'
import { errorData, exceptionType } from './errorMetadata.ts'
import { observe } from './observation.ts'
import {
  createChildContext,
  createSpanContext,
  isOTelInternal,
  ROOT_BOUNDARY,
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

type ExecutionObserver =
  NonNullable<AtomMeta['_executionObservers']> extends Set<infer T> ? T : never
type Outcome = Parameters<Extract<ReturnType<ExecutionObserver>, Fn>>[0]

/** One admission/completion implementation serves actions and atom executions. */
export const createWithOTel = ({
  reserveSpan,
  isActive,
  captureValues = false,
}: CreateWithOTelInput) => {
  const storage = createSpanContext()
  const links = createLinkCollector()
  const optionsByTarget = new WeakMap<
    AtomLike,
    WithOTelOptions & { enabled: boolean }
  >()

  const observeSpan = (
    name: string,
    options: WithOTelOptions & { enabled: boolean },
    actionTarget: boolean,
    params: readonly unknown[],
    previousState: unknown,
    root = false,
    execution?: LinkExecution,
  ): ((outcome: Outcome) => void) | undefined => {
    if (!isActive()) return
    const reservation = options.enabled ? observe(reserveSpan) : undefined
    const parent = observe(() => {
      const value = root
        ? ROOT_BOUNDARY
        : (storage.read(STACK.length - 2) ?? ROOT_BOUNDARY)
      // Even rejected/filtered invocations carry the parent or an explicit
      // boundary through wrap(), without creating a nonexistent span parent.
      storage.write(value)
      return value
    })
    if (!reservation) return
    if (name.length > 16_384) {
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
        ? actionTarget
          ? { params: captured('params', params) }
          : { prevState: captured('prevState', previousState) }
        : undefined
      // Redaction can dispose this adapter while the input is being captured.
      if (!isActive()) return
      const ctx = createChildContext(parent)
      storage.write(ctx)
      if (execution) execution.context = ctx
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
          links: execution?.links,
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
                [actionTarget ? 'payload' : 'nextState']: captured(
                  actionTarget ? 'payload' : 'nextState',
                  value,
                ),
              }
            : undefined,
        )
      return { success, queueErr, emitErr }
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
    const failure = (error: unknown, async: boolean) =>
      complete(() => {
        if (!actionTarget && !async) {
          if (error instanceof Promise) reservation.skip()
          else span.queueErr(error)
        } else span.emitErr(error)
      })
    return (outcome) => {
      if (!outcome.ok) {
        failure(outcome.error, false)
        return
      }
      if (!isActive()) {
        complete(() => {})
        return
      }
      const attached = observe(() => {
        const result = outcome.value
        if (result instanceof Promise) {
          result
            .then(
              bind(success),
              bind((error: unknown) => failure(error, true)),
            )
            .catch(() => {})
        } else success(result)
        return true
      })
      // A hostile .then can register a callback and then throw. Close the
      // finalizer so that a later callback cannot inspect a dropped result.
      if (!attached) complete(() => {})
    }
  }

  // Each execution overlays a complete context only for its synchronous body.
  // Continuations keep their captured record; later executions of this frame
  // must not inherit a completed execution's context (including other adapters).
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
    options: WithOTelOptions & { enabled: boolean },
    params: readonly unknown[],
    callback: () => Result,
    root = false,
  ): Result => {
    const finish = begin(name, options, true, params, undefined, root)
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
    if (isOTelInternal(target)) return target
    const existing = optionsByTarget.get(target)
    if (existing) {
      Object.assign(existing, options)
      existing.enabled ||= enabled
      return target
    }
    const settings = { ...options, enabled }
    optionsByTarget.set(target, settings)
    if (isAction(target)) {
      target.extend(
        withActionMiddleware(
          () =>
            (next: Fn, ...params: unknown[]) =>
              invoke(target.name, settings, params, () => next(...params)),
        ),
      )
    } else {
      const observer: ExecutionObserver = (event) => {
        if (!isActive()) return
        const execution = links.start(event.frame)
        const finish = begin(
          target.name,
          settings,
          false,
          event.params,
          event.previousState,
          false,
          execution,
        )
        return (outcome) => {
          // Borrowed frames are inspected only at synchronous execution end.
          // Promise completion retains the resulting owned ID pairs only.
          observe(() =>
            links.finish(event.frame, event.previousPubs, execution),
          )
          finish?.(outcome)
        }
      }
      ;(target.__reatom._executionObservers ??= new Set()).add(observer)
    }
    return target
  }
  const withOTel = (options: WithOTelOptions = {}): GenericExt<AtomLike> =>
    ((target: AtomLike) =>
      install(target, options, true)) as GenericExt<AtomLike>

  const rootOptions = { enabled: true }

  return {
    dispose: () => {
      storage.dispose()
      links.dispose()
    },
    withOTel,
    auto: <Target extends AtomLike>(target: Target, enabled: boolean) =>
      install(target, {}, enabled),
    startTrace: <Result>(name: string, callback: () => Result): Result => {
      if (!isActive()) return callback()
      // A trace boundary retains the caller's dependency tracking. begin/end
      // scope the overlay; wrap/bind retain it for async continuations.
      return invoke(name, rootOptions, [], callback, true)
    },
    getCurrentContext: () => (isActive() ? storage.current() : undefined),
  }
}
