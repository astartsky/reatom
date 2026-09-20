import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'

const record = (value, label) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), label)
  return value
}
const array = (value, label) => {
  assert(Array.isArray(value), label)
  return value
}
const text = (value, label) => {
  assert.equal(typeof value, 'string', label)
  return value
}
const nanos = (value, label) => {
  assert(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value), label)
  const result = BigInt(value)
  assert(result <= (1n << 64n) - 1n, label)
  return result
}
const durationBound = (value, label) => {
  assert(typeof value === 'string' || typeof value === 'bigint', label)
  return nanos(String(value), label)
}

const attributes = (entries = []) => {
  const result = Object.create(null)
  for (const entry of array(entries, 'attributes must be an array')) {
    record(entry, 'invalid attribute')
    const key = text(entry.key, 'attribute key must be a string')
    assert(!Object.hasOwn(result, key), `duplicate attribute: ${key}`)
    result[key] = anyValue(entry.value)
  }
  return result
}

// Map prototypes are not OTLP semantics. Keep primitive values, array shape,
// and every enumerable own key strict, including symbols and special keys.
const comparableAttribute = (value) => {
  if (value === null || typeof value !== 'object') return value
  const isArray = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    prototype !== null &&
    prototype !== Object.prototype &&
    (!isArray || prototype !== Array.prototype)
  )
    return value
  const result = isArray ? new Array(value.length) : Object.create(null)
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.getOwnPropertyDescriptor(value, key).enumerable) continue
    Object.defineProperty(result, key, {
      value: comparableAttribute(value[key]),
      enumerable: true,
    })
  }
  return result
}

// Preserve int64 precision with decimal strings outside the safe number range.
// Bytes and non-finite doubles keep their canonical JSON string representation.
const anyValue = (value) => {
  const keys = Object.keys(record(value, 'invalid AnyValue'))
  if (keys.length === 0) return null
  assert.equal(keys.length, 1, 'AnyValue must contain exactly one value')
  const key = keys[0]
  const item = value[key]
  switch (key) {
    case 'stringValue':
      return text(item, 'invalid stringValue')
    case 'boolValue':
      assert.equal(typeof item, 'boolean', 'invalid boolValue')
      return item
    case 'intValue': {
      assert(
        typeof item === 'string' && /^-?(0|[1-9]\d*)$/.test(item),
        'invalid intValue',
      )
      const integer = BigInt(item)
      assert(
        integer >= -(1n << 63n) && integer < 1n << 63n,
        'intValue outside int64',
      )
      return integer >= BigInt(Number.MIN_SAFE_INTEGER) &&
        integer <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(integer)
        : item
    }
    case 'doubleValue':
      assert(
        (typeof item === 'number' && Number.isFinite(item)) ||
          ['NaN', 'Infinity', '-Infinity'].includes(item),
        'invalid doubleValue',
      )
      return item
    case 'bytesValue':
      text(item, 'invalid bytesValue')
      assert.equal(
        Buffer.from(item, 'base64').toString('base64'),
        item,
        'invalid base64 bytesValue',
      )
      return item
    case 'arrayValue':
      return array(
        record(item, 'invalid arrayValue').values ?? [],
        'invalid arrayValue.values',
      ).map(anyValue)
    case 'kvlistValue':
      return attributes(record(item, 'invalid kvlistValue').values ?? [])
    default:
      assert.fail(`unknown AnyValue field: ${key}`)
  }
}

/**
 * Decode Collector file-exporter OTLP JSONL, independently of adapter code.
 * During polling, only newline-terminated records are read. The final read also
 * parses an unterminated last record, so a truncated tail cannot pass shutdown.
 * Span fields and scope stay in OTLP form; resource is a normalized attribute
 * map.
 */
export const decodeJsonl = (input, { final = true } = {}) => {
  text(input, 'JSONL input must be a string')
  assert.equal(typeof final, 'boolean', 'final must be a boolean')
  const lines = input.split('\n')
  if (!final) lines.pop()
  const spans = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    let payload
    try {
      payload = JSON.parse(line)
    } catch {
      assert.fail(`invalid JSONL at line ${index + 1}`)
    }
    record(payload, 'invalid OTLP envelope')
    for (const group of array(
      payload.resourceSpans,
      'resourceSpans must be an array',
    )) {
      record(group, 'invalid ResourceSpans')
      const resource = attributes(
        record(group.resource ?? {}, 'invalid resource').attributes,
      )
      for (const scoped of array(
        group.scopeSpans ?? [],
        'scopeSpans must be an array',
      )) {
        record(scoped, 'invalid ScopeSpans')
        const scope = record(scoped.scope ?? {}, 'invalid scope')
        attributes(scope.attributes)
        for (const span of array(
          scoped.spans ?? [],
          'spans must be an array',
        )) {
          record(span, 'invalid span')
          spans.push({ ...span, resource, scope })
        }
      }
    }
  }
  return spans
}

const id = (value, length, label) => {
  assert(
    typeof value === 'string' &&
      new RegExp(`^[0-9a-f]{${length}}$`).test(value) &&
      !/^0+$/.test(value),
    `invalid ${label}: expected nonzero canonical hex`,
  )
  return value
}
const pair = (span) =>
  `${id(span.traceId, 32, 'traceId')}/${id(span.spanId, 16, 'spanId')}`
const parentId = (span) => {
  const parent = span.parentSpanId
  if (parent === undefined || parent === '' || parent === '0000000000000000')
    return undefined
  return id(parent, 16, 'parentSpanId')
}
const indexPairs = (spans, label) => {
  const index = new Map()
  for (const span of array(spans, `${label} must be an array`)) {
    record(span, `invalid ${label} span`)
    const key = pair(span)
    assert(!index.has(key), `duplicate ${label} pair: ${key}`)
    index.set(key, span)
  }
  return index
}
const statusCode = (span) => {
  const status = record(span.status ?? {}, 'invalid status')
  if (status.message !== undefined)
    text(status.message, 'invalid status message')
  const code = status.code ?? 0
  assert([0, 1, 2].includes(code), `invalid status code: ${span.name}`)
  return code
}
const events = (span) =>
  array(span.events ?? [], 'events must be an array').map((event) => {
    record(event, 'invalid event')
    text(event.name, 'invalid event name')
    nanos(event.timeUnixNano ?? '0', 'invalid event timestamp')
    return { name: event.name, attributes: attributes(event.attributes) }
  })

const graph = (spans) => {
  const index = indexPairs(spans, 'Collector')
  const spanIds = new Set(spans.map((span) => span.spanId))
  const parents = new Map()
  for (const [key, span] of index) {
    const resource = record(span.resource, 'missing span resource')
    for (const key of ['service.name', 'test.case_id'])
      assert(
        text(resource[key], `missing resource ${key}`).length > 0,
        `empty resource ${key}`,
      )
    assert(text(span.name, 'invalid span name').length > 0, 'empty span name')
    assert(
      Number.isInteger(span.kind) && span.kind >= 0 && span.kind <= 5,
      `invalid kind: ${span.name}`,
    )
    const start = nanos(
      span.startTimeUnixNano,
      `invalid start timestamp: ${span.name}`,
    )
    const end = nanos(
      span.endTimeUnixNano,
      `invalid end timestamp: ${span.name}`,
    )
    assert(end >= start, `negative duration: ${span.name}`)
    statusCode(span)
    attributes(span.attributes)
    events(span)
    assert.equal(
      array(span.links ?? [], 'links must be an array').length,
      0,
      `unexpected links: ${span.name}`,
    )
    assert.equal(
      span.droppedLinksCount ?? 0,
      0,
      `unexpected dropped links: ${span.name}`,
    )
    const parent = parentId(span)
    if (!parent) continue
    const parentKey = `${span.traceId}/${parent}`
    assert(
      index.has(parentKey),
      `${spanIds.has(parent) ? 'foreign' : 'missing'} parent: ${span.name}`,
    )
    parents.set(key, parentKey)
  }
  const complete = new Set()
  for (const key of index.keys()) {
    const path = new Set()
    let current = key
    while (current && !complete.has(current)) {
      assert(!path.has(current), 'parent cycle')
      path.add(current)
      current = parents.get(current)
    }
    for (const visited of path) complete.add(visited)
  }
  return { index, parents }
}

const checkPrivacy = (value, sentinels) => {
  if (typeof value === 'string') {
    for (const sentinel of sentinels) {
      assert(!value.includes(sentinel), 'private sentinel leaked')
      // Captured params/payload can themselves be JSON encoded strings.
      assert(
        !value.includes(JSON.stringify(sentinel).slice(1, -1)),
        'private sentinel leaked',
      )
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      checkPrivacy(key, sentinels)
      checkPrivacy(item, sentinels)
    }
  }
}

/**
 * Validate the entire supplied graph before selecting test.case_id. Names in
 * relationships/spanExpectations must resolve uniquely within that case.
 * relationships: { child, parent: string | null, ancestry?: boolean }[].
 * spanExpectations: { name, kind?, statusCode?, attributes?, eventNames?,
 * forbiddenEventNames?, minDurationNs?, maxDurationNs? }[]. Duration bounds are
 * unsigned decimal strings or bigint. Expected attributes are partial matches.
 * Returns all case spans sorted by semantic content, without IDs/timestamps.
 * Links are forbidden: this oracle covers the selected actions-only contract.
 */
export const verifyCase = (
  spans,
  {
    caseId,
    serviceName,
    requiredNames = [],
    forbiddenNames = [],
    privateSentinels = [],
    expectedCount,
    relationships = [],
    spanExpectations = [],
    scopeName,
    scopeVersion,
  },
) => {
  assert(text(caseId, 'caseId must be a string').length > 0, 'empty caseId')
  assert(
    text(serviceName, 'serviceName must be a string').length > 0,
    'empty serviceName',
  )
  const { index, parents } = graph(spans)
  for (const sentinel of array(privateSentinels, 'invalid privateSentinels'))
    assert(
      text(sentinel, 'invalid private sentinel').length > 0,
      'empty private sentinel',
    )
  checkPrivacy(spans, privateSentinels)
  const selected = spans.filter(
    (span) => span.resource?.['test.case_id'] === caseId,
  )
  if (expectedCount !== undefined) {
    assert(
      Number.isInteger(expectedCount) && expectedCount >= 0,
      'invalid expectedCount',
    )
    assert.equal(selected.length, expectedCount, `case count: ${caseId}`)
  } else {
    assert(selected.length > 0, `missing case spans: ${caseId}`)
  }
  const byName = new Map()
  for (const span of selected) {
    assert.equal(
      span.resource['service.name'],
      serviceName,
      `resource service: ${span.name}`,
    )
    if (scopeName !== undefined)
      assert.equal(span.scope?.name, scopeName, 'scope name')
    if (scopeVersion !== undefined)
      assert.equal(span.scope?.version, scopeVersion, 'scope version')
    const parent = index.get(parents.get(pair(span)))
    if (parent) {
      assert.equal(
        parent.resource?.['test.case_id'],
        caseId,
        'cross-case parent',
      )
      assert.equal(
        parent.resource?.['service.name'],
        serviceName,
        'cross-service parent',
      )
    }
    const named = byName.get(span.name) ?? []
    named.push(span)
    byName.set(span.name, named)
  }
  for (const name of array(requiredNames, 'invalid requiredNames'))
    assert(byName.has(name), `missing required span: ${name}`)
  for (const name of array(forbiddenNames, 'invalid forbiddenNames'))
    assert(!byName.has(name), `forbidden span: ${name}`)
  const unique = (name) => {
    const matches = byName.get(name) ?? []
    assert(matches.length > 0, `missing expected span: ${name}`)
    assert.equal(matches.length, 1, `ambiguous span name: ${name}`)
    return matches[0]
  }
  const ancestors = (span) => {
    const result = []
    let current = parents.get(pair(span))
    while (current) {
      result.push(index.get(current))
      current = parents.get(current)
    }
    return result
  }
  for (const { child, parent, ancestry = false } of array(
    relationships,
    'invalid relationships',
  )) {
    assert.equal(typeof ancestry, 'boolean', 'invalid ancestry option')
    const descendant = unique(child)
    if (parent === null) {
      assert(!parents.has(pair(descendant)), `expected root: ${child}`)
    } else {
      const ancestor = unique(parent)
      const candidates = ancestors(descendant)
      assert(
        ancestry ? candidates.includes(ancestor) : candidates[0] === ancestor,
        `${ancestry ? 'ancestry' : 'parent'} mismatch: ${child} -> ${parent}`,
      )
    }
  }
  for (const expected of array(spanExpectations, 'invalid spanExpectations')) {
    const span = unique(expected.name)
    if (expected.kind !== undefined)
      assert.equal(span.kind, expected.kind, `kind: ${span.name}`)
    if (expected.statusCode !== undefined)
      assert.equal(
        statusCode(span),
        expected.statusCode,
        `status: ${span.name}`,
      )
    const actualAttributes = attributes(span.attributes)
    for (const [key, value] of Object.entries(expected.attributes ?? {})) {
      assert(
        Object.hasOwn(actualAttributes, key),
        `missing attribute: ${span.name}.${key}`,
      )
      assert.deepEqual(
        comparableAttribute(actualAttributes[key]),
        comparableAttribute(value),
        `attribute: ${span.name}.${key}`,
      )
    }
    const names = events(span).map((event) => event.name)
    for (const name of expected.eventNames ?? [])
      assert(names.includes(name), `missing event: ${span.name}.${name}`)
    for (const name of expected.forbiddenEventNames ?? [])
      assert(!names.includes(name), `forbidden event: ${span.name}.${name}`)
    const duration =
      BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)
    if (expected.minDurationNs !== undefined)
      assert(
        duration >=
          durationBound(expected.minDurationNs, 'invalid minDurationNs'),
        `duration too short: ${span.name}`,
      )
    if (expected.maxDurationNs !== undefined)
      assert(
        duration <=
          durationBound(expected.maxDurationNs, 'invalid maxDurationNs'),
        `duration too long: ${span.name}`,
      )
  }
  return selected
    .map((span) => {
      const lineage = ancestors(span).map((ancestor) => ancestor.name)
      return {
        name: span.name,
        parent: lineage[0] ?? null,
        ancestors: lineage,
        kind: span.kind,
        statusCode: statusCode(span),
        attributes: attributes(span.attributes),
        events: events(span),
        resource: span.resource,
        scope: span.scope,
      }
    })
    .sort((a, b) => {
      const left = JSON.stringify(a),
        right = JSON.stringify(b)
      return left < right ? -1 : left > right ? 1 : 0
    })
}

/** Compare flattened Collector and passive request-observer span pairs. */
export const verifyDelivery = (spans, wireSpans) => {
  const received = [...indexPairs(spans, 'Collector').keys()].sort()
  const sent = [...indexPairs(wireSpans, 'wire').keys()].sort()
  assert.deepEqual(received, sent, 'delivery pair set mismatch')
  return received
}
