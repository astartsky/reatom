import { atom, type AtomMeta, context, top } from './'

const initialContexts = context.count
const first = top()
const value = atom(7)
value.set(9)
const cached = value.__reatom._frame
const initialMetaOnly = cached !== undefined && !first.root.store.has(value)
const source = atom(() => 1)
const observed: number[] = []
type Observer =
  NonNullable<AtomMeta['_executionObservers']> extends Set<infer T> ? T : never
const observer: Observer = () => {
  observed.push(value())
  return () => {
    observed.push(value())
  }
}
;(source.__reatom._executionObservers ??= new Set()).add(observer)
try {
  source()
  const second = context.start(() => {
    source()
    return top()
  })
  // Revisit the default store after the runtime has switched to store lookup.
  source.set(2)
  const metaPreserved = value.__reatom._frame === cached
  const defaultStoreUntouched = !first.root.store.has(value)
  const secondStoreUntouched = !second.root.store.has(value)
  const ordinaryValues = second.run(() => [value(), value.set(6)])
  ordinaryValues.push(value())
  console.log(
    JSON.stringify({
      initialContexts,
      initialMetaOnly,
      observed,
      metaPreserved,
      defaultStoreUntouched,
      secondStoreUntouched,
      ordinaryValues,
    }),
  )
} finally {
  source.__reatom._executionObservers?.delete(observer)
}
