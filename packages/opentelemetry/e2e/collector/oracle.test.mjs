/* global structuredClone */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeJsonl, verifyCase, verifyDelivery } from './oracle.mjs'

// Independent OTLP fixtures: no adapter serializers, builders, or runtime.
const trace = '1234567890abcdef1234567890abcdef'
const otherTrace = 'abcdef1234567890abcdef1234567890'
const id = (n) => n.toString(16).padStart(16, '0')
const attribute = (key, value) => ({ key, value: { stringValue: value } })
const scope = { name: '@reatom/opentelemetry', version: 'fixture' }
const resource = [
  attribute('service.name', 'oracle-app'),
  attribute('test.case_id', 'case-1'),
  attribute('test.run_id', 'run-1'),
]
const span = (n, name, parent, extra = {}) => ({
  traceId: trace,
  spanId: id(n),
  ...(parent === undefined ? {} : { parentSpanId: id(parent) }),
  name,
  kind: 1,
  startTimeUnixNano: '100',
  endTimeUnixNano: '200',
  attributes: [],
  events: [],
  ...extra,
})
const fixture = () => [
  span(1, 'ui'),
  // The async child may outlive its parent; that is not a topology violation.
  span(2, 'work', 1, { startTimeUnixNano: '120', endTimeUnixNano: '500' }),
  span(3, 'failure', 2, {
    status: { code: 2 },
    attributes: [
      attribute('public', 'PUBLIC'),
      attribute('private', '[Redacted]'),
    ],
    events: [
      {
        name: 'exception',
        timeUnixNano: '150',
        attributes: [attribute('exception.message', '[Error]')],
      },
    ],
  }),
  span(4, 'recovery', 2),
]
const envelope = (spans, attrs = resource, instrumentation = scope) => ({
  resourceSpans: [
    {
      resource: { attributes: attrs },
      scopeSpans: [{ scope: instrumentation, spans }],
    },
  ],
})
const jsonl = (spans) => `${JSON.stringify(envelope(spans))}\n`
const decoded = () => decodeJsonl(jsonl(fixture()))
const manifest = () => ({
  caseId: 'case-1',
  serviceName: 'oracle-app',
  scopeName: scope.name,
  scopeVersion: scope.version,
  requiredNames: ['ui', 'work', 'failure', 'recovery'],
  forbiddenNames: ['computed', '_time'],
  privateSentinels: ['PRIVATE\n😀'],
  expectedCount: 4,
  relationships: [
    { child: 'ui', parent: null },
    { child: 'work', parent: 'ui' },
    { child: 'failure', parent: 'work' },
    { child: 'recovery', parent: 'ui', ancestry: true },
  ],
  spanExpectations: [
    { name: 'work', kind: 1, minDurationNs: '300', maxDurationNs: 400n },
    {
      name: 'failure',
      statusCode: 2,
      eventNames: ['exception'],
      attributes: { public: 'PUBLIC', private: '[Redacted]' },
    },
    { name: 'recovery', statusCode: 0, forbiddenEventNames: ['exception'] },
  ],
})

test('out-of-order, regrouped records preserve every scope/span and semantic topology', () => {
  const raw = fixture()
  const first = envelope([raw[2]])
  first.resourceSpans[0].scopeSpans.push({ scope, spans: [raw[1]] })
  first.resourceSpans.push(...envelope([raw[3]]).resourceSpans)
  const output = `${JSON.stringify(first)}\n${JSON.stringify(envelope([raw[0]]))}\n`
  const spans = decodeJsonl(output)
  assert.deepEqual(
    spans.map((entry) => entry.name),
    ['failure', 'work', 'recovery', 'ui'],
  )
  assert.deepEqual(spans[0].scope, scope)
  assert.deepEqual(spans[0].events, raw[2].events)
  const projection = verifyCase(spans, manifest())
  assert.deepEqual(projection, verifyCase(decoded(), manifest()))
  assert.deepEqual(
    projection.map(({ name, parent, ancestors }) => ({
      name,
      parent,
      ancestors,
    })),
    [
      { name: 'failure', parent: 'work', ancestors: ['work', 'ui'] },
      { name: 'recovery', parent: 'work', ancestors: ['work', 'ui'] },
      { name: 'ui', parent: null, ancestors: [] },
      { name: 'work', parent: 'ui', ancestors: ['ui'] },
    ],
  )
  assert(!JSON.stringify(projection).includes(trace))
  assert(!Object.hasOwn(projection[0], 'startTimeUnixNano'))
})

test('AnyValue normalization keeps precision, nested values, bytes, and special keys', () => {
  const attrs = [
    ...resource,
    { key: 'count', value: { intValue: '42' } },
    { key: 'large', value: { intValue: '9223372036854775807' } },
    { key: 'negative', value: { intValue: '-9223372036854775808' } },
    { key: 'bytes', value: { bytesValue: 'AQID' } },
    {
      key: 'nested',
      value: {
        kvlistValue: {
          values: [
            {
              key: 'array',
              value: {
                arrayValue: {
                  values: [
                    { boolValue: false },
                    { doubleValue: 1.5 },
                    { doubleValue: 'NaN' },
                    {},
                  ],
                },
              },
            },
          ],
        },
      },
    },
    attribute('__proto__', 'ordinary attribute'),
  ]
  const [item] = decodeJsonl(
    `${JSON.stringify(envelope([fixture()[0]], attrs))}\n`,
  )
  assert.equal(item.resource.count, 42)
  assert.equal(item.resource.large, '9223372036854775807')
  assert.equal(item.resource.negative, '-9223372036854775808')
  assert.equal(item.resource.bytes, 'AQID')
  assert.deepEqual(item.resource.nested.array, [false, 1.5, 'NaN', null])
  assert.equal(item.resource.__proto__, 'ordinary attribute')
  assert.equal(Object.getPrototypeOf(item.resource), null)
})

test('nested kvlist expectations accept ordinary literals without weakening leaf equality', () => {
  const spans = decoded()
  spans[2].attributes.push({
    key: 'details',
    value: {
      kvlistValue: {
        values: [
          {
            key: 'items',
            value: {
              arrayValue: {
                values: [
                  { intValue: '7' },
                  {
                    kvlistValue: {
                      values: [
                        attribute('label', 'PUBLIC'),
                        { key: 'active', value: { boolValue: false } },
                        attribute('__proto__', 'ordinary data'),
                      ],
                    },
                  },
                  {},
                ],
              },
            },
          },
          attribute('constructor', 'own data'),
        ],
      },
    },
  })
  const expected = {
    items: [
      7,
      { label: 'PUBLIC', active: false, ['__proto__']: 'ordinary data' },
      null,
    ],
    constructor: 'own data',
  }
  const options = (details) => ({
    ...manifest(),
    spanExpectations: [
      ...manifest().spanExpectations,
      { name: 'failure', attributes: { details } },
    ],
  })
  const projection = verifyCase(spans, options(expected))
  const actual = projection.find((item) => item.name === 'failure').attributes
    .details
  assert.equal(Object.getPrototypeOf(actual), null)
  assert.equal(Object.getPrototypeOf(actual.items[1]), null)
  assert(Object.hasOwn(actual.items[1], '__proto__'))
  assert.equal(actual.items[1].__proto__, 'ordinary data')
  assert.equal(Object.getPrototypeOf(expected.items[1]), Object.prototype)
  verifyCase(spans, options(actual))

  for (const change of [
    (value) => {
      value.items[1].label = 'WRONG'
    },
    (value) => {
      value.items[0] = '7'
    },
    (value) => {
      value.items[1].active = 'false'
    },
    (value) => {
      value.items[1].__proto__ = 'WRONG'
    },
    (value) => {
      value.items[2] = undefined
    },
    (value) => {
      value.items[2] = NaN
    },
    (value) => {
      value.items.extra = true
    },
    (value) => {
      value.items[1][Symbol('extra')] = true
    },
    (value) => {
      delete value.constructor
    },
  ]) {
    const wrong = structuredClone(expected)
    change(wrong)
    assert.throws(
      () => verifyCase(spans, options(wrong)),
      /attribute: failure.details/,
    )
  }
})

test('polling defers an unterminated tail; final read rejects truncation', () => {
  const complete = jsonl([fixture()[0]])
  const tail = '{"resourceSpans":['
  assert.equal(decodeJsonl(complete + tail, { final: false }).length, 1)
  assert.throws(() => decodeJsonl(complete + tail), /invalid JSONL at line 2/)
  assert.throws(
    () => decodeJsonl(complete + tail + '\n', { final: false }),
    /invalid JSONL at line 2/,
  )
  assert.throws(
    () => decodeJsonl(tail + '\n' + complete, { final: false }),
    /invalid JSONL at line 1/,
  )
  assert.equal(decodeJsonl(complete.trimEnd()).length, 1)
  assert.equal(decodeJsonl(complete.trimEnd(), { final: false }).length, 0)
  assert.deepEqual(decodeJsonl(''), [])
  assert.deepEqual(decodeJsonl('{"resourceSpans":[]}\n'), [])
})

for (const [name, payload, error] of [
  ['missing envelope', {}, /resourceSpans/],
  ['wrong envelope type', { resourceSpans: {} }, /resourceSpans/],
  ['wrong scope list', { resourceSpans: [{ scopeSpans: {} }] }, /scopeSpans/],
  [
    'duplicate attributes',
    envelope([], [...resource, resource[0]]),
    /duplicate attribute/,
  ],
  [
    'ambiguous AnyValue',
    envelope([], [{ key: 'bad', value: { intValue: '1', stringValue: 'x' } }]),
    /exactly one/,
  ],
  [
    'unsafe integer input',
    envelope([], [{ key: 'bad', value: { intValue: 9007199254740992 } }]),
    /invalid intValue/,
  ],
  [
    'int64 overflow',
    envelope([], [{ key: 'bad', value: { intValue: '9223372036854775808' } }]),
    /outside int64/,
  ],
  [
    'malformed bytes',
    envelope([], [{ key: 'bad', value: { bytesValue: 'AQ!D' } }]),
    /invalid base64/,
  ],
]) {
  test(`decoder rejects ${name}`, () => {
    assert.throws(() => decodeJsonl(JSON.stringify(payload)), error)
  })
}

for (const [name, corrupt, error] of [
  ['missing parent', (spans) => spans.shift(), /missing parent/],
  [
    'duplicate pair',
    (spans) => spans.push(structuredClone(spans[0])),
    /duplicate Collector pair/,
  ],
  [
    'foreign-trace parent',
    (spans) => {
      spans[0].traceId = otherTrace
    },
    /foreign parent/,
  ],
  [
    'all-roots graph',
    (spans) => {
      for (const item of spans) delete item.parentSpanId
    },
    /parent mismatch: work -> ui/,
  ],
  [
    'wrong existing parent',
    (spans) => {
      spans[2].parentSpanId = id(1)
    },
    /parent mismatch: failure -> work/,
  ],
  [
    'parent cycle',
    (spans) => {
      spans[0].parentSpanId = id(4)
    },
    /parent cycle/,
  ],
  [
    'self parent',
    (spans) => {
      spans[1].parentSpanId = id(2)
    },
    /parent cycle/,
  ],
  [
    'stale link',
    (spans) => {
      spans[3].links = [{ traceId: trace, spanId: id(1) }]
    },
    /unexpected links/,
  ],
  [
    'dropped link',
    (spans) => {
      spans[3].droppedLinksCount = 1
    },
    /unexpected dropped links/,
  ],
  [
    'negative duration',
    (spans) => {
      spans[1].endTimeUnixNano = '119'
    },
    /negative duration/,
  ],
  [
    'short controlled wait',
    (spans) => {
      spans[1].endTimeUnixNano = '200'
    },
    /duration too short/,
  ],
  [
    'long controlled wait',
    (spans) => {
      spans[1].endTimeUnixNano = '999'
    },
    /duration too long/,
  ],
  [
    'wrong error status',
    (spans) => {
      spans[2].status.code = 1
    },
    /status: failure/,
  ],
  [
    'stale recovery error',
    (spans) => {
      spans[3].status = { code: 2 }
    },
    /status: recovery/,
  ],
  [
    'missing exception',
    (spans) => {
      spans[2].events = []
    },
    /missing event/,
  ],
  [
    'stale recovery exception',
    (spans) => {
      spans[3].events = structuredClone(spans[2].events)
    },
    /forbidden event/,
  ],
  [
    'wrong public content',
    (spans) => {
      spans[2].attributes[0].value.stringValue = 'lost'
    },
    /attribute: failure.public/,
  ],
  [
    'wrong service',
    (spans) => {
      spans[0].resource['service.name'] = 'foreign'
    },
    /resource service/,
  ],
  [
    'wrong case',
    (spans) => {
      for (const item of spans) item.resource['test.case_id'] = 'other'
    },
    /case count/,
  ],
  [
    'missing case tag',
    (spans) => {
      delete spans[0].resource['test.case_id']
    },
    /missing resource test.case_id/,
  ],
  [
    'wrong scope',
    (spans) => {
      spans[0].scope.name = 'foreign'
    },
    /scope name/,
  ],
  [
    'invalid status enum',
    (spans) => {
      spans[0].status = { code: 'STATUS_CODE_OK' }
    },
    /invalid status code/,
  ],
  [
    'numeric timestamp',
    (spans) => {
      spans[0].startTimeUnixNano = 100
    },
    /invalid start timestamp/,
  ],
  [
    'invalid timestamp',
    (spans) => {
      spans[0].endTimeUnixNano = '1e10'
    },
    /invalid end timestamp/,
  ],
  [
    'timestamp overflow',
    (spans) => {
      spans[0].endTimeUnixNano = '18446744073709551616'
    },
    /invalid end timestamp/,
  ],
]) {
  test(`oracle rejects ${name}`, () => {
    const spans = decoded()
    verifyCase(spans, manifest())
    corrupt(spans)
    assert.throws(() => verifyCase(spans, manifest()), error)
  })
}

for (const [field, value] of [
  ['traceId', '0'.repeat(32)],
  ['traceId', 'a'.repeat(31)],
  ['traceId', trace.toUpperCase()],
  ['traceId', 'EjRWeJCrze8SNFZ4kKvN7w=='],
  ['spanId', '0'.repeat(16)],
  ['spanId', '1'],
  ['parentSpanId', 'not-an-id'],
]) {
  test(`canonical nonzero IDs: reject ${field}=${value}`, () => {
    const spans = decoded()
    spans[0][field] = value
    assert.throws(
      () => verifyCase(spans, manifest()),
      new RegExp(`invalid ${field}`),
    )
  })
}

test('empty and all-zero root parent representations are allowed, not guessed parents', () => {
  for (const parent of ['', '0000000000000000']) {
    const spans = decoded()
    spans[0].parentSpanId = parent
    verifyCase(spans, manifest())
  }
})

for (const location of [
  'attributes',
  'event',
  'status',
  'resource',
  'scope',
  'name',
]) {
  test(`privacy scans ${location}, including decoded control characters`, () => {
    const spans = decoded()
    const secret = 'PRIVATE\n😀'
    const item = spans[2]
    if (location === 'attributes')
      item.attributes.push(attribute('nested', JSON.stringify({ secret })))
    if (location === 'event')
      item.events[0].attributes.push(attribute('secret', secret))
    if (location === 'status') item.status.message = secret
    if (location === 'resource') item.resource.secret = secret
    if (location === 'scope') item.scope.version = secret
    if (location === 'name') item.name = secret
    assert.throws(
      () => verifyCase(spans, manifest()),
      /private sentinel leaked/,
    )
  })
}

test('case requirements distinguish missing, forbidden, and ambiguous semantic names', () => {
  const missing = decoded().filter((item) => item.name !== 'recovery')
  assert.throws(
    () => verifyCase(missing, { ...manifest(), expectedCount: undefined }),
    /missing required span: recovery/,
  )
  const forbidden = decoded()
  forbidden[3].name = 'computed'
  assert.throws(
    () => verifyCase(forbidden, { ...manifest(), requiredNames: [] }),
    /forbidden span: computed/,
  )
  const ambiguous = decoded()
  ambiguous.push({ ...ambiguous[3], spanId: id(5) })
  assert.throws(
    () => verifyCase(ambiguous, { ...manifest(), expectedCount: undefined }),
    /ambiguous span name: recovery/,
  )
  assert.throws(() => verifyCase([], manifest()), /case count/)
  assert.throws(
    () => verifyCase([], { ...manifest(), expectedCount: undefined }),
    /missing case spans/,
  )
})

test('expectedCount rejects an extra valid same-case root', () => {
  const spans = decoded()
  verifyCase(spans, manifest())
  const extra = {
    ...spans[0],
    traceId: otherTrace,
    spanId: id(99),
    name: 'extra-allowed-root',
  }
  const expanded = [...spans, extra]
  verifyCase(expanded, { ...manifest(), expectedCount: 5 })
  assert.throws(() => verifyCase(expanded, manifest()), /case count: case-1/)
})

test('ancestry permits intermediate spans but direct-parent assertions do not', () => {
  verifyCase(decoded(), manifest())
  assert.throws(
    () =>
      verifyCase(decoded(), {
        ...manifest(),
        relationships: [{ child: 'recovery', parent: 'ui' }],
      }),
    /parent mismatch/,
  )
  assert.throws(
    () =>
      verifyCase(decoded(), {
        ...manifest(),
        relationships: [
          { child: 'failure', parent: 'recovery', ancestry: true },
        ],
      }),
    /ancestry mismatch/,
  )
  assert.throws(
    () =>
      verifyCase(decoded(), {
        ...manifest(),
        relationships: [{ child: 'work', parent: null }],
      }),
    /expected root/,
  )
})

test('whole input is validated before landmarks and case projection; foreign case cannot supply a parent', () => {
  const spans = decoded()
  const other = {
    ...spans[0],
    traceId: otherTrace,
    name: 'other-case',
    resource: { ...spans[0].resource, 'test.case_id': 'case-2' },
  }
  verifyCase([...spans, other], manifest())
  assert.deepEqual(
    verifyCase([...spans, other], {
      caseId: 'denied',
      serviceName: 'oracle-app',
      expectedCount: 0,
    }),
    [],
  )
  assert.throws(
    () =>
      verifyCase([...spans, { ...other, parentSpanId: id(99) }], manifest()),
    /missing parent/,
  )
  const crossCase = decoded()
  crossCase[0].resource = { ...crossCase[0].resource, 'test.case_id': 'case-2' }
  assert.throws(
    () => verifyCase(crossCase, { ...manifest(), expectedCount: undefined }),
    /cross-case parent/,
  )
})

test('nanosecond duration comparisons do not round through Number', () => {
  const spans = decoded()
  spans[1].startTimeUnixNano = '9007199254740992'
  spans[1].endTimeUnixNano = '9007199254740993'
  const options = {
    ...manifest(),
    spanExpectations: [{ name: 'work', minDurationNs: 1n, maxDurationNs: '1' }],
  }
  verifyCase(spans, options)
  assert.throws(
    () =>
      verifyCase(spans, {
        ...options,
        spanExpectations: [{ name: 'work', minDurationNs: '2' }],
      }),
    /duration too short/,
  )
  assert.throws(
    () =>
      verifyCase(spans, {
        ...options,
        spanExpectations: [{ name: 'work', minDurationNs: 9007199254740992 }],
      }),
    /invalid minDurationNs/,
  )
})

test('the same spanId in separate traces is valid; full pairs retain both deliveries', () => {
  const spans = decoded()
  const other = {
    ...spans[0],
    traceId: otherTrace,
    resource: { ...spans[0].resource, 'test.case_id': 'case-2' },
  }
  const received = [...spans, other]
  verifyCase(received, manifest())
  assert.equal(verifyDelivery(received, [other, ...fixture()]).length, 5)
  assert.throws(
    () => verifyDelivery(received, fixture()),
    /delivery pair set mismatch/,
  )
})

test('delivery compares exact full pairs, independent of ordering and envelope grouping', () => {
  const spans = decoded()
  const before = decoded()
  const freeze = (value) => {
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) freeze(item)
      Object.freeze(value)
    }
  }
  freeze(spans)
  const pairs = verifyDelivery(spans, fixture().reverse())
  assert.equal(pairs.length, 4)
  assert(pairs.every((key) => key.startsWith(`${trace}/`)))
  verifyCase(spans, manifest())
  assert.deepEqual(spans, before)
  assert.throws(
    () => verifyDelivery(spans.slice(1), fixture()),
    /delivery pair set mismatch/,
  )
  assert.throws(() => verifyDelivery(spans, []), /delivery pair set mismatch/)
  assert.throws(
    () => verifyDelivery([], fixture()),
    /delivery pair set mismatch/,
  )
  assert.throws(
    () => verifyDelivery([...spans, spans[0]], fixture()),
    /duplicate Collector pair/,
  )
  assert.throws(
    () => verifyDelivery(spans, [...fixture(), fixture()[0]]),
    /duplicate wire pair/,
  )
  assert.throws(
    () =>
      verifyDelivery(
        spans,
        fixture().map((item) => ({ ...item, traceId: otherTrace })),
      ),
    /delivery pair set mismatch/,
  )
  assert.deepEqual(verifyDelivery([], []), [])
})
