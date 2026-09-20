import { nonFiniteString } from './nonFiniteString.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'

export type CaptureValuesOptions =
  | false
  | { redact?: (key: string, value: unknown) => unknown }

const MAX_DEPTH = 2
const MAX_ENTRIES = 100
const MAX_STRING_LENGTH = 2048
const MAX_BYTES = 8192
const INT64_MIN = -(1n << 63n)
const INT64_MAX = (1n << 63n) - 1n
const TRUNCATED = '[Truncated]'
const MARKER_BYTES = 13 // JSON string including quotes; all fixed markers fit.
const encoder = new TextEncoder()
const stringBytes = (value: string) =>
  encoder.encode(JSON.stringify(value)).length
const byteLengthGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'length',
)!.get!
const byteBrandGetter = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)!.get!

// Scan at most MAX_STRING_LENGTH UTF-16 units, preserving surrogate pairs.
// JSON escapes lone surrogates and control characters before UTF-8 encoding.
const stringPrefix = (value: string, maxUnits: number, maxBytes: number) => {
  let end = 0
  let bytes = 0
  while (end < value.length && end < maxUnits) {
    const code = value.charCodeAt(end)
    let units = 1
    let cost = 1
    if (code === 34 || code === 92) cost = 2
    else if (code < 32) cost = [8, 9, 10, 12, 13].includes(code) ? 2 : 6
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(end + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        units = 2
        cost = 4
      } else cost = 6
    } else if (code >= 0xdc00 && code <= 0xdfff) cost = 6
    else if (code > 0x7ff) cost = 3
    else if (code > 0x7f) cost = 2
    if (end + units > maxUnits || bytes + cost > maxBytes) break
    end += units
    bytes += cost
  }
  return value.slice(0, end)
}

/**
 * One session owns a shared traversal/size budget across params and payload.
 *
 * The size bound is the sum of UTF-8 JSON `[key, normalizedValue]` pairs, with
 * byte arrays represented as base64 strings and int64 bigints as decimal
 * strings. It includes escaping, keys, delimiters and markers, but not OTLP
 * wrappers or record metadata. Accounting is conservative: each value reserves
 * at least 13 bytes, each container also reserves a truncation member, and
 * unused reservations are not refunded.
 *
 * Traversal slots cover roots, attempted own keys (including symbols and
 * non-enumerable keys), array holes and length descriptors. Exhaustion stops
 * application traversal/redaction. Containers mark omitted content with a tail
 * (arrays) or `[Truncated]` member (records, replacing that key if necessary).
 * A later capture returns a charged marker; if even its key/marker cannot fit,
 * it throws RangeError so the observation boundary can cancel the record.
 *
 * Only ordinary arrays, plain records and Uint8Array are traversed. Accessors
 * are `[Skipped]`; opaque objects and other unsupported types use fixed
 * markers. Redaction sees roots and readable child values before normalization.
 * Its failures and Proxy trap failures propagate; there is no input fallback.
 * Reflect.ownKeys can materialize all keys; arbitrary Proxy traps and redact
 * cannot have a hard CPU bound. Descriptors/values are visited only on budget.
 */
export const createValueCapture = (
  redact?: (key: string, value: unknown) => unknown,
): { capture: (key: string, value: unknown) => OtlpAttrValue } => {
  let bytes = MAX_BYTES
  let entries = MAX_ENTRIES

  const reserve = (size: number) => {
    if (size > bytes) return false
    bytes -= size
    return true
  }

  // Every call has already reserved MARKER_BYTES for its result.
  const visit = (
    key: string,
    input: unknown,
    depth: number,
    ancestors: WeakSet<object>,
  ): OtlpAttrValue => {
    const value = redact ? redact(key, input) : input
    if (value === null) return '[Null]'
    if (value === undefined) return '[Undefined]'
    if (typeof value === 'function') return '[Function]'
    if (typeof value === 'symbol') return '[Symbol]'
    if (typeof value === 'bigint') {
      // Range-check before conversion: arbitrary-size decimal conversion is
      // unbounded. Int64 values retain their OTLP integer representation.
      const result =
        value < INT64_MIN || value > INT64_MAX ? '[Unsafe bigint]' : value
      const cost = stringBytes(
        typeof result === 'bigint' ? String(result) : result,
      )
      return reserve(Math.max(0, cost - MARKER_BYTES)) ? result : TRUNCATED
    }
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') {
      const result = nonFiniteString(value) ?? value
      const cost = encoder.encode(JSON.stringify(result)).length
      return reserve(Math.max(0, cost - MARKER_BYTES)) ? result : TRUNCATED
    }
    if (typeof value === 'string') {
      if (value.length <= MAX_STRING_LENGTH) {
        const cost = stringBytes(value)
        if (reserve(Math.max(0, cost - MARKER_BYTES))) return value
      }
      const prefix = stringPrefix(
        value,
        MAX_STRING_LENGTH - TRUNCATED.length,
        bytes,
      )
      const result = prefix + TRUNCATED
      reserve(stringBytes(result) - MARKER_BYTES)
      return result
    }

    if (ArrayBuffer.isView(value)) {
      // The intrinsic brand accepts Buffer/subclasses without user hooks.
      if (byteBrandGetter.call(value) !== 'Uint8Array') return '[Opaque]'
      // Use the intrinsic getter and indexed byte reads, never user length,
      // constructor/species, slice, or iterator properties.
      const length: number = byteLengthGetter.call(value)
      const cost = 2 + 4 * Math.ceil(length / 3)
      if (!reserve(Math.max(0, cost - MARKER_BYTES))) return TRUNCATED
      const result = new Uint8Array(length)
      for (let i = 0; i < length; i++) result[i] = (value as Uint8Array)[i]!
      return result
    }

    if (ancestors.has(value)) return '[Circular]'
    if (depth >= MAX_DEPTH) return TRUNCATED
    const array = Array.isArray(value)
    if (!array) {
      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== null && prototype !== Object.prototype)
        return '[Opaque]'
    }

    // Include braces/brackets, a possible preceding comma and truncation tail.
    const containerBytes = array
      ? 2 + 1 + MARKER_BYTES
      : 2 + 1 + MARKER_BYTES * 2 + 1
    if (!reserve(containerBytes - MARKER_BYTES)) return TRUNCATED
    ancestors.add(value)
    try {
      if (array) {
        if (entries === 0) return TRUNCATED
        entries--
        const length: unknown = Object.getOwnPropertyDescriptor(
          value,
          'length',
        )?.value
        if (
          typeof length !== 'number' ||
          !Number.isSafeInteger(length) ||
          length < 0
        )
          return '[Opaque]'
        const result: OtlpAttrValue[] = []
        for (let i = 0; i < length; i++) {
          if (entries === 0 || !reserve(1 + MARKER_BYTES)) {
            result.push(TRUNCATED)
            break
          }
          entries--
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
          result.push(
            descriptor && !('value' in descriptor)
              ? '[Skipped]'
              : visit(String(i), descriptor?.value, depth + 1, ancestors),
          )
        }
        return result
      }

      const result = Object.create(null) as Record<string, OtlpAttrValue>
      if (entries === 0) {
        result[TRUNCATED] = TRUNCATED
        return result
      }
      // Object.keys/getOwnPropertyDescriptors would inspect every descriptor.
      const keys = Reflect.ownKeys(value)
      for (let i = 0; i < keys.length; i++) {
        const childKey = keys[i]!
        if (entries === 0) {
          result[TRUNCATED] = TRUNCATED
          break
        }
        entries--
        if (typeof childKey !== 'string') continue
        if (
          childKey.length > MAX_STRING_LENGTH ||
          !reserve(stringBytes(childKey) + 2 + MARKER_BYTES)
        ) {
          result[TRUNCATED] = TRUNCATED
          break
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, childKey)
        if (!descriptor?.enumerable) continue
        result[childKey] =
          'value' in descriptor
            ? visit(childKey, descriptor.value, depth + 1, ancestors)
            : '[Skipped]'
      }
      return result
    } finally {
      ancestors.delete(value)
    }
  }

  return {
    capture(key, value) {
      // Bound key work too: oversized root keys cannot be renamed by this API.
      if (
        key.length > MAX_STRING_LENGTH ||
        !reserve(stringBytes(key) + 3 + MARKER_BYTES)
      )
        throw new RangeError('Value capture budget exhausted')
      if (entries === 0) return TRUNCATED
      entries--
      return visit(key, value, 0, new WeakSet())
    },
  }
}
