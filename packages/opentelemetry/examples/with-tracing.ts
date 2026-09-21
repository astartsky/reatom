import { action, atom, computed, wrap } from '@reatom/core'
import {
  reatomOpentelemetry,
  type ReatomOpentelemetryInput,
} from '@reatom/opentelemetry'

/** Create tracing before models so the adapter sees their construction. */
export const createTracedCounter = (options: ReatomOpentelemetryInput) => {
  const otel = reatomOpentelemetry(options)
  const count = atom(0, 'example.count')
  const doubled = computed(() => count() * 2, 'example.double')
  const increment = action(
    () => count.set((value) => value + 1),
    'example.increment',
  )
  const incrementAfter = action(async (wait: Promise<void>) => {
    const parent = otel.getCurrentContext()
    await wrap(wait)
    return otel.withContext(parent, increment)
  }, 'example.incrementAfter')

  return {
    count,
    doubled,
    update: () =>
      otel.startTrace('example.update', () => ({
        count: increment(),
        doubled: doubled(),
        context: otel.getCurrentContext(),
      })),
    updateAfter: (wait: Promise<void>) =>
      otel.startTrace('example.updateAfter', () => incrementAfter(wait)),
    flush: otel.flush,
    dispose: otel.dispose,
  }
}
