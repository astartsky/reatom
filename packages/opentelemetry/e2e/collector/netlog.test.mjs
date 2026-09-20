import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import test from 'node:test'

import { readHttpRequests } from './netlog.mjs'

const capture = (...events) => ({
  constants: { logEventTypes: { SOCKET_BYTES_SENT: 82 } },
  events,
})
const sent = (bytes, id = 1, type = 10) => {
  const buffer = Buffer.from(bytes)
  return {
    type: 82,
    source: { type, id },
    params: { byte_count: buffer.length, bytes: buffer.toString('base64') },
  }
}

test('reassembles arbitrary chunks before decoding multibyte UTF8', () => {
  const bytes = Buffer.from(
    'POST /v1/traces HTTP/1.1\r\nHost: collector:4318\r\nContent-Length: 6\r\n\r\nλ😀',
  )
  const expected = [
    {
      sourceType: 10,
      sourceId: 1,
      method: 'POST',
      target: '/v1/traces',
      headers: { host: 'collector:4318', 'content-length': '6' },
      body: 'λ😀',
    },
  ]
  for (let split = 0; split <= bytes.length; split++) {
    assert.deepEqual(
      readHttpRequests(
        capture(sent(bytes.subarray(0, split)), sent(bytes.subarray(split))),
      ),
      expected,
    )
  }
  assert.deepEqual(
    readHttpRequests(capture(...Array.from(bytes, (byte) => sent([byte])))),
    expected,
  )
})

test('groups interleaved sockets by both source fields and preserves event order', () => {
  const events = [
    sent('GET /first ', 7, 10),
    sent('GET /other-id HTTP/1.1\r\n\r\n', 8, 10),
    sent('GET /other-type HTTP/1.1\r\n\r\n', 7, 11),
    sent('HTTP/1.1\r\n\r\n', 7, 10),
  ]
  // Deliberately reversed timestamps: array order is the byte stream order.
  events.forEach((event, index) => (event.time = String(10 - index)))
  assert.deepEqual(
    readHttpRequests(capture(...events)).map(
      ({ sourceType, sourceId, target }) => ({ sourceType, sourceId, target }),
    ),
    [
      { sourceType: 10, sourceId: 7, target: '/first' },
      { sourceType: 10, sourceId: 8, target: '/other-id' },
      { sourceType: 11, sourceId: 7, target: '/other-type' },
    ],
  )
})

test('preserves preflight, repeated POSTs, unrelated destinations and body boundaries', () => {
  const preflight =
    'OPTIONS /v1/traces HTTP/1.1\r\nHost: collector:4318\r\n\r\n'
  const post =
    'POST /v1/traces HTTP/1.1\r\nHost: collector:4318\r\nContent-Length: 4\r\n\r\n\r\n\r\n'
  const other = 'GET /other HTTP/1.1\r\nHost: app:3000\r\n\r\n'
  const requests = readHttpRequests(
    capture(sent(preflight + post + post + other)),
  )
  assert.deepEqual(
    requests.map(({ method, target, body }) => ({ method, target, body })),
    [
      { method: 'OPTIONS', target: '/v1/traces', body: '' },
      { method: 'POST', target: '/v1/traces', body: '\r\n\r\n' },
      { method: 'POST', target: '/v1/traces', body: '\r\n\r\n' },
      { method: 'GET', target: '/other', body: '' },
    ],
  )
  assert.equal(requests[3].headers.host, 'app:3000')
})

test('reads only the named outgoing event type, with no input mutation', () => {
  const log = capture(sent('GET / HTTP/1.1\r\n\r\n'))
  log.constants.logEventTypes.SOCKET_BYTES_SENT = 900
  log.events[0].type = 900
  log.events.push({ type: 82, params: {} }, { type: 83, params: {} })
  const before = JSON.stringify(log)
  assert.equal(readHttpRequests(log).length, 1)
  assert.equal(JSON.stringify(log), before)
  assert.deepEqual(readHttpRequests(capture()), [])
})

test('normalizes header names and OWS without losing special keys or a body BOM', () => {
  const [request] = readHttpRequests(
    capture(
      sent(
        'POST / HTTP/1.1\r\nHoSt:\tcollector:4318 \t\r\n__proto__: kept\r\nContent-Length: 0003\r\n\r\n\uFEFF',
      ),
    ),
  )
  assert.deepEqual(request.headers, {
    host: 'collector:4318',
    ['__proto__']: 'kept',
    'content-length': '0003',
  })
  assert.equal(request.body, '\uFEFF')
})

for (const [name, wire] of [
  ['partial headers', 'GET / HTTP/1.1\r\nHost: a\r\n'],
  ['partial body', 'POST / HTTP/1.1\r\nContent-Length: 2\r\n\r\nx'],
  ['trailing incomplete request', 'GET / HTTP/1.1\r\n\r\nG'],
  ['body without framing', 'POST / HTTP/1.1\r\n\r\n{}'],
  ['duplicate header', 'GET / HTTP/1.1\r\nHost: a\r\nhOsT: a\r\n\r\n'],
  [
    'duplicate length',
    'POST / HTTP/1.1\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n',
  ],
  [
    'transfer encoding',
    'POST / HTTP/1.1\r\nTransfer-Encoding: identity\r\n\r\n',
  ],
  ['colonless header', 'GET / HTTP/1.1\r\nHost a\r\n\r\n'],
  ['whitespace in header name', 'GET / HTTP/1.1\r\nHost : a\r\n\r\n'],
  ['folded header', 'GET / HTTP/1.1\r\nHost: a\r\n extra\r\n\r\n'],
  ['control in header value', 'GET / HTTP/1.1\r\nHost: a\u0000\r\n\r\n'],
  ['bare LF', 'GET / HTTP/1.1\nHost: a\n\n'],
  ['LF before request-line CRLF', 'GET / HTTP/1.1\n\r\n\r\n'],
  ['LF before header CRLF', 'GET / HTTP/1.1\r\nHost: a\n\r\n\r\n'],
  ['HTTP2 preface', 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'],
  ['HTTP1.0', 'GET / HTTP/1.0\r\n\r\n'],
  ['invalid method', 'G(ET / HTTP/1.1\r\n\r\n'],
  ['extra request-line field', 'GET / extra HTTP/1.1\r\n\r\n'],
]) {
  test(`rejects ${name}`, () =>
    assert.throws(() => readHttpRequests(capture(sent(wire)))))
}

for (const length of [
  '',
  '-1',
  '+1',
  '1.0',
  '1e1',
  '1,1',
  '1 1',
  '0x10',
  '9007199254740992',
]) {
  test(`rejects malformed/unsafe Content-Length ${JSON.stringify(length)}`, () => {
    assert.throws(() =>
      readHttpRequests(
        capture(sent(`POST / HTTP/1.1\r\nContent-Length: ${length}\r\n\r\n`)),
      ),
    )
  })
}

for (const bytes of ['!', 'Zg', 'Zg===', 'Zh==', 'Zg==\n', '_w==']) {
  test(`rejects noncanonical base64 ${JSON.stringify(bytes)}`, () => {
    const event = sent('')
    event.params = { bytes, byte_count: Buffer.from(bytes, 'base64').length }
    assert.throws(() => readHttpRequests(capture(event)), /base64/i)
  })
}

test('rejects missing captured bytes and mismatched byte counts', () => {
  for (const params of [
    { byte_count: 0 },
    { bytes: null, byte_count: 0 },
    { bytes: '' },
    { bytes: '', byte_count: 1 },
    { bytes: '', byte_count: '0' },
  ]) {
    const event = sent('')
    event.params = params
    assert.throws(() => readHttpRequests(capture(event)))
  }
  const event = sent('')
  delete event.params
  assert.throws(() => readHttpRequests(capture(event)))
})

test('rejects missing event metadata and invalid source identities', () => {
  for (const log of [
    {},
    { constants: {}, events: [] },
    { constants: { logEventTypes: { SOCKET_BYTES_SENT: 82 } } },
  ]) {
    assert.throws(() => readHttpRequests(log))
  }
  for (const source of [
    undefined,
    {},
    { type: 10, id: '1' },
    { type: -1, id: 1 },
  ]) {
    const event = sent('GET / HTTP/1.1\r\n\r\n')
    event.source = source
    assert.throws(() => readHttpRequests(capture(event)))
  }
})

test('rejects invalid UTF8 instead of inserting replacement characters', () => {
  for (const body of [[0xff], [0xc0, 0xaf], [0xe2, 0x82]]) {
    const bytes = Buffer.concat([
      Buffer.from(`POST / HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`),
      Buffer.from(body),
    ])
    assert.throws(() => readHttpRequests(capture(sent(bytes))))
  }
})

test('does not return a valid prefix when a later socket capture is incomplete', () => {
  assert.throws(() =>
    readHttpRequests(
      capture(sent('GET / HTTP/1.1\r\n\r\n', 1), sent('GET / HTTP/1.1\r\n', 2)),
    ),
  )
})
