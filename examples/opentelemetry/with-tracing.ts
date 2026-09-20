import { action, atom, computed } from '@reatom/core'
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

  return {
    count,
    doubled,
    update: () =>
      otel.startTrace('example.update', () => ({
        count: increment(),
        doubled: doubled(),
        context: otel.getCurrentContext(),
      })),
    flush: otel.flush,
    dispose: otel.dispose,
  }
}
