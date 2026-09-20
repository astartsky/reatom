import type { AtomLike, Frame } from '@reatom/core'

import type { SpanInput } from './buildSpan.ts'
import type { SpanContext } from './spanContext.ts'

export interface LinkExecution {
  readonly order: number
  completed: boolean
  context?: SpanContext
  links?: SpanInput['links']
}

export const createLinkCollector = () => {
  let order = 0
  let disposed = false
  // Values contain only execution order and owned IDs, never graph history.
  let executions = new WeakMap<Frame, LinkExecution>()
  return {
    start: (frame: Frame): LinkExecution => {
      const execution = { order: ++order, completed: false }
      // Even an execution without an admitted span invalidates older metadata.
      if (!disposed) executions.set(frame, execution)
      return execution
    },
    finish: (
      frame: Frame,
      previous: readonly (Frame | null)[],
      execution: LinkExecution,
    ) => {
      if (disposed) return
      if (executions.get(frame) !== execution) {
        // Nested executions on one mutable frame do not prove which result
        // belongs to the inner span after the outer execution returns.
        executions.delete(frame)
      }
      execution.completed = true
      if (!execution.context || previous.length < 2 || frame.pubs.length < 2)
        return

      const links: SpanContext[] = []
      const linked = new Set<string>()
      const visited = new Set<Frame>([frame])
      let remaining = 256
      const walk = (
        before: readonly (Frame | null)[],
        after: readonly (Frame | null)[],
      ) => {
        // Complete each local match or omit it: an unexamined suffix could
        // contain another version of the same target, making it ambiguous.
        const size = before.length + after.length - 2
        if (size > remaining) return
        remaining -= size
        const index = (pubs: readonly (Frame | null)[]) => {
          const byTarget = new Map<AtomLike, Frame | null>()
          for (let i = 1; i < pubs.length; i++) {
            const pub = pubs[i]!
            if (!pub || pub.root !== frame.root) continue
            const seen = byTarget.get(pub.atom)
            byTarget.set(
              pub.atom,
              seen === undefined || seen === pub ? pub : null,
            )
          }
          return byTarget
        }
        const oldInputs = index(before)
        const newInputs = index(after)
        for (const [target, current] of newInputs) {
          if (links.length === 32) break
          const old = oldInputs.get(target)
          if (
            !old ||
            !current ||
            (Object.is(old.state, current.state) &&
              Object.is(old.error, current.error)) ||
            visited.has(current)
          )
            continue
          visited.add(current)
          const cause = executions.get(current)
          if (
            cause?.completed &&
            cause.context &&
            cause.order < execution.order
          ) {
            const { traceId, spanId } = cause.context
            const key = `${traceId}:${spanId}`
            if (
              !linked.has(key) &&
              (traceId !== execution.context!.traceId ||
                spanId !== execution.context!.spanId)
            ) {
              linked.add(key)
              links.push({ traceId, spanId })
            }
          } else {
            // Silent copies and current descendants have no eligible context.
            // Follow only changes also present in their paired old inputs.
            walk(old.pubs, current.pubs)
          }
        }
      }
      walk(previous, frame.pubs)
      if (links.length) execution.links = links
    },
    dispose: () => {
      disposed = true
      executions = new WeakMap()
    },
  }
}
