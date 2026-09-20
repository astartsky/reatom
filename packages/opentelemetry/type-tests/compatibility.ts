import type { AtomLike, Ext, GenericExt } from '@reatom/core'
import { action, atom, computed, withParams } from '@reatom/core'

import type { ReatomOpentelemetry } from '../dist/index.js'
import { reatomOpentelemetry } from '../dist/index.js'

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false

declare function expectExact<Check extends true>(_check?: Check): void

// Compile-only consumer of the built entrypoint. These functions are never run.
export function verifyTypes() {
  const otel = reatomOpentelemetry({
    endpoint: 'http://collector.invalid',
    serviceName: 'type-consumer',
  })
  expectExact<Equal<typeof otel, ReatomOpentelemetry>>()
  const rawAction = action(
    (n: number, label: string) => ({ n, label }),
    'types.action',
  )
  const tracedAction = rawAction.extend(otel.withOTel())
  const _rawPayload = rawAction(1, 'raw')
  const _tracedPayload = tracedAction(1, 'traced')
  expectExact<Equal<typeof tracedAction, typeof rawAction>>()
  expectExact<
    Equal<Parameters<typeof tracedAction>, [n: number, label: string]>
  >()
  expectExact<Equal<typeof _tracedPayload, { n: number; label: string }>>()
  expectExact<Equal<typeof _tracedPayload, typeof _rawPayload>>()
  // @ts-expect-error action requires a number as the first argument
  tracedAction('bad', 'label')
  // @ts-expect-error raw action rejects the same invalid argument
  rawAction('bad', 'label')
  // @ts-expect-error action requires its label argument
  tracedAction(1)
  // @ts-expect-error raw action also requires its label argument
  rawAction(1)

  const rawAsyncAction = action(
    async (id: number) => ({ id }),
    'types.asyncAction',
  )
  const tracedAsyncAction = rawAsyncAction.extend(otel.withOTel())
  const _asyncPayload = tracedAsyncAction(1)
  expectExact<Equal<typeof tracedAsyncAction, typeof rawAsyncAction>>()
  expectExact<Equal<typeof _asyncPayload, Promise<{ id: number }>>>()

  const rawCounter = atom(0, 'types.counter')
  const tracedCounter = rawCounter.extend(otel.withOTel())
  const _current = tracedCounter()
  const _assigned = tracedCounter.set(2)
  const _updated = tracedCounter.set((previous) => {
    expectExact<Equal<typeof previous, number>>()
    return previous + 1
  })
  expectExact<Equal<typeof tracedCounter, typeof rawCounter>>()
  expectExact<Equal<typeof _current, number>>()
  expectExact<Equal<typeof _assigned, number>>()
  expectExact<Equal<typeof _updated, number>>()
  // @ts-expect-error atom calls only read; writes use .set
  tracedCounter(1)
  // @ts-expect-error raw atom rejects positional writes too
  rawCounter(1)
  // @ts-expect-error setter requires a number
  tracedCounter.set('bad')
  // @ts-expect-error raw setter also requires a number
  rawCounter.set('bad')
  // @ts-expect-error updater must return a number
  tracedCounter.set(() => 'bad')
  // @ts-expect-error raw updater must return a number
  rawCounter.set(() => 'bad')
  // @ts-expect-error updater receives the numeric state
  tracedCounter.set((previous: string) => previous.length)

  const rawParsed = atom('', 'types.params').extend(
    withParams((n: number) => String(n)),
  )
  const tracedParsed = rawParsed.extend(otel.withOTel())
  const _parsed = tracedParsed.set(1)
  const _parsedUpdate = tracedParsed.set((previous) => {
    expectExact<Equal<typeof previous, string>>()
    return previous + '!'
  })
  expectExact<Equal<typeof tracedParsed, typeof rawParsed>>()
  expectExact<Equal<Parameters<typeof tracedParsed.set>, [n: number]>>()
  expectExact<Equal<typeof _parsed, string>>()
  expectExact<Equal<typeof _parsedUpdate, string>>()
  // @ts-expect-error withParams changes the value setter to accept a number
  tracedParsed.set('bad')
  // @ts-expect-error raw withParams target also rejects a string value
  rawParsed.set('bad')
  // @ts-expect-error withParams does not widen the updater result
  tracedParsed.set(() => 1)

  const rawComputed = computed(() => rawCounter() * 2, 'types.computed')
  const tracedComputed = rawComputed.extend(otel.withOTel())
  const _derived = tracedComputed()
  expectExact<Equal<typeof tracedComputed, typeof rawComputed>>()
  expectExact<Equal<typeof _derived, number>>()
  expectExact<Equal<typeof tracedComputed.set, unknown>>()
  // @ts-expect-error computed .set is not callable
  tracedComputed.set(1)
  // @ts-expect-error raw computed .set is not callable either
  rawComputed.set(1)
  // @ts-expect-error computed cannot be made writable with an updater
  tracedComputed.set(() => 1)
  // @ts-expect-error computed also rejects positional writes
  tracedComputed(1)

  const extraLabel = 'kept' as const
  const rawExtended = atom(0, 'types.extended').extend((target) => ({
    extra: extraLabel,
    increment: (delta: number) => target.set((previous) => previous + delta),
    doubled: computed(() => target() * 2, 'types.extended.doubled'),
  }))
  const tracedExtended = rawExtended.extend(otel.withOTel())
  const _incremented = tracedExtended.increment(2)
  const _doubled = tracedExtended.doubled()
  expectExact<Equal<typeof tracedExtended, typeof rawExtended>>()
  expectExact<Equal<typeof tracedExtended.extra, 'kept'>>()
  expectExact<
    Equal<typeof tracedExtended.increment, typeof rawExtended.increment>
  >()
  expectExact<
    Equal<Parameters<typeof tracedExtended.increment>, [delta: number]>
  >()
  expectExact<Equal<typeof _incremented, number>>()
  expectExact<
    Equal<typeof tracedExtended.doubled, typeof rawExtended.doubled>
  >()
  expectExact<Equal<typeof _doubled, number>>()
  // @ts-expect-error an existing extension method retains its parameter type
  tracedExtended.increment('bad')

  const extension = otel.withOTel()
  expectExact<Equal<typeof extension, GenericExt<AtomLike>>>()
  const actionExtension: Ext<typeof rawAction, typeof rawAction> = extension
  const _actionThroughExt = rawAction.extend(actionExtension)
  expectExact<Equal<typeof _actionThroughExt, typeof rawAction>>()
  // @ts-expect-error OTel extensions require an AtomLike target
  extension({ value: 1 })

  const syncValue: { readonly id: number; status: 'ready' } = {
    id: 1,
    status: 'ready',
  }
  const syncCallback = () => syncValue
  const _syncResult = otel.startTrace('types.syncRoot', syncCallback)
  expectExact<Equal<typeof _syncResult, typeof syncValue>>()
  expectExact<Equal<typeof _syncResult, ReturnType<typeof syncCallback>>>()

  const identity = <Value>(value: Value): Value => value
  const _returnedFunction = otel.startTrace(
    'types.functionRoot',
    () => identity,
  )
  expectExact<Equal<typeof _returnedFunction, typeof identity>>()

  const pending = Promise.resolve(syncValue)
  const _promiseResult = otel.startTrace('types.promiseRoot', () => pending)
  expectExact<Equal<typeof _promiseResult, typeof pending>>()
  expectExact<Equal<typeof _promiseResult, Promise<typeof syncValue>>>()

  const asyncCallback = async () => syncValue
  const _asyncResult = otel.startTrace('types.asyncRoot', asyncCallback)
  expectExact<Equal<typeof _asyncResult, ReturnType<typeof asyncCallback>>>()
  expectExact<Equal<typeof _asyncResult, Promise<typeof syncValue>>>()

  const promiseTag: { readonly tag: 'kept' } = { tag: 'kept' }
  const taggedPromise = Object.assign(Promise.resolve(syncValue), promiseTag)
  const _taggedResult = otel.startTrace(
    'types.taggedPromiseRoot',
    () => taggedPromise,
  )
  expectExact<Equal<typeof _taggedResult, typeof taggedPromise>>()
  expectExact<Equal<typeof _taggedResult.tag, 'kept'>>()
  // @ts-expect-error startTrace does not accept callbacks requiring arguments
  otel.startTrace('types.badCallback', (value: number) => value)
}

export function verifyGenericExtension<Target extends AtomLike>(
  otel: ReturnType<typeof reatomOpentelemetry>,
  target: Target,
) {
  const extension = otel.withOTel()
  const generic: GenericExt<AtomLike> = extension
  const compatible: Ext<Target, Target> = extension
  const _direct = extension(target)
  const _throughGeneric = generic(target)
  const _throughExt = compatible(target)
  expectExact<Equal<typeof _direct, Target>>()
  expectExact<Equal<typeof _throughGeneric, Target>>()
  expectExact<Equal<typeof _throughExt, Target>>()
}
