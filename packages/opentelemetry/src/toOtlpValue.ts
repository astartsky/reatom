import { isRec } from '@reatom/core'

import { nonFiniteString } from './nonFiniteString.ts'
import { toOtlpBytesValue } from './toOtlpBytesValue.ts'

export type OtlpAttrValue =
  | string
  | number
  | bigint
  | boolean
  | OtlpAttrValue[]
  | { [key: string]: OtlpAttrValue }
  | Uint8Array

// intValue is a string: int64 JSON encoding per https://protobuf.dev/programming-guides/json/
export type OtlpAnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { boolValue: boolean }
  | OtlpDoubleValue
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: { key: string; value: OtlpAnyValue }[] } }
  | { bytesValue: string }

type OtlpDoubleValue = {
  doubleValue: number | 'NaN' | 'Infinity' | '-Infinity'
}

const CIRCULAR: OtlpAnyValue = { stringValue: '[Circular]' }

const INT64_MAX = (1n << 63n) - 1n //  9_223_372_036_854_775_807n
const INT64_MIN = -(1n << 63n) //     -9_223_372_036_854_775_808n

const toOtlpStringValue = (value: string) => ({ stringValue: value })

const toOtlpIntValue = (value: number | bigint) => ({
  intValue: String(value),
})

const toOtlpBoolValue = (value: boolean) => ({ boolValue: value })

const toOtlpDoubleValue = (value: number): OtlpDoubleValue => ({
  doubleValue: nonFiniteString(value) ?? value,
})

// Ancestor-stack cycle detection: add on enter, remove on exit so shared-but-
// non-cyclic references like { a: x, b: x } aren't false-flagged as cycles.
const encodeOtlpValue = (
  value: OtlpAttrValue,
  seen: WeakSet<object>,
): OtlpAnyValue => {
  if (typeof value === 'string') return toOtlpStringValue(value)
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value)) return toOtlpIntValue(value)
    // Outside the safe-integer range (incl. integer-valued doubles like
    // 2^53+1, NaN, ±Infinity), JS already represents the value as a
    // 64-bit double — emit it as such. OTLP's intValue is int64, which
    // we can't fulfill faithfully past 2^53; doubleValue is the spec-aligned
    // wire form for everything else.
    return toOtlpDoubleValue(value)
  }
  if (typeof value === 'boolean') return toOtlpBoolValue(value)
  if (typeof value === 'bigint') {
    if (value > INT64_MAX || value < INT64_MIN) {
      return toOtlpStringValue(`[Unsafe bigint ${value}]`)
    }
    return toOtlpIntValue(value)
  }
  if (value instanceof Uint8Array) return toOtlpBytesValue(value)
  if (Array.isArray(value)) {
    if (seen.has(value)) return CIRCULAR
    seen.add(value)
    const result = {
      arrayValue: { values: value.map((item) => encodeOtlpValue(item, seen)) },
    }
    seen.delete(value)
    return result
  }
  if (isRec(value)) {
    if (seen.has(value)) return CIRCULAR
    seen.add(value)
    const result = {
      kvlistValue: {
        values: encodeAttributes(value as Record<string, OtlpAttrValue>, seen),
      },
    }
    seen.delete(value)
    return result
  }
  return toOtlpStringValue(String(value))
}

export const toOtlpValue = (value: OtlpAttrValue): OtlpAnyValue =>
  encodeOtlpValue(value, new WeakSet())

// null/undefined keys are dropped: a concrete {stringValue: 'null'} attribute
// pollutes backend searches and aggregations by blurring absence with real
// string data. Per OTel common spec, empty-string / zero / empty-array are
// meaningful and preserved; only nullish is considered "no value".
const encodeAttributes = (
  record: Record<string, OtlpAttrValue> | undefined,
  seen: WeakSet<object>,
): { key: string; value: OtlpAnyValue }[] => {
  if (!record) return []
  const result: { key: string; value: OtlpAnyValue }[] = []
  for (const [key, value] of Object.entries(record)) {
    if (value === null || value === undefined) continue
    result.push({ key, value: encodeOtlpValue(value, seen) })
  }
  return result
}

export const toOtlpAttributes = (
  record: Record<string, OtlpAttrValue> | undefined,
) => encodeAttributes(record, new WeakSet())
