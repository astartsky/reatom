import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { TextDecoder } from 'node:util'

/**
 * Read outgoing plain HTTP/1.1 from a completed Chromium NetLog Everything
 * capture. TLS, HTTP/2 and transfer encodings are intentionally unsupported.
 * Requests are grouped by first-seen socket; each socket keeps event-array
 * order. Filtering and delivery/duplicate assertions belong to the caller.
 */
export function readHttpRequests(netlogObject) {
  const sentType = netlogObject?.constants?.logEventTypes?.SOCKET_BYTES_SENT
  assert(
    Number.isSafeInteger(sentType) && sentType >= 0,
    'Missing SOCKET_BYTES_SENT type',
  )
  assert(Array.isArray(netlogObject.events), 'Missing NetLog events')
  const sockets = new Map()
  for (const event of netlogObject.events) {
    assert(Number.isSafeInteger(event?.type), 'Invalid NetLog event type')
    if (event.type !== sentType) continue
    const { type: sourceType, id: sourceId } = event.source ?? {}
    assert(
      Number.isSafeInteger(sourceType) &&
        sourceType >= 0 &&
        Number.isSafeInteger(sourceId) &&
        sourceId >= 0,
      'Invalid socket source identity',
    )
    const key = `${sourceType}:${sourceId}`
    const { bytes, byte_count: byteCount } = event.params ?? {}
    assert.equal(
      typeof bytes,
      'string',
      `Missing captured bytes at socket ${key}`,
    )
    const chunk = Buffer.from(bytes, 'base64')
    assert.equal(
      chunk.toString('base64'),
      bytes,
      `Noncanonical base64 at socket ${key}`,
    )
    assert.equal(
      chunk.length,
      byteCount,
      `Incorrect byte_count at socket ${key}`,
    )
    let socket = sockets.get(key)
    if (!socket) {
      socket = { sourceType, sourceId, chunks: [] }
      sockets.set(key, socket)
    }
    socket.chunks.push(chunk)
  }

  const requests = []
  // Preserve a leading BOM as data, and reject malformed or truncated UTF8.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  for (const { sourceType, sourceId, chunks } of sockets.values()) {
    const stream = Buffer.concat(chunks)
    const label = `socket ${sourceType}:${sourceId}`
    let offset = 0
    while (offset < stream.length) {
      const headerEnd = stream.indexOf('\r\n\r\n', offset)
      assert(headerEnd >= 0, `Partial HTTP headers at ${label}`)
      const [line, ...lines] = stream
        .subarray(offset, headerEnd)
        .toString('latin1')
        .split('\r\n')
      const request =
        /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) ([\x21-\x7e]+) HTTP\/1\.1$/.exec(line)
      assert(request, `Invalid HTTP/1.1 request line at ${label}`)
      const [, method, target] = request
      const headers = new Map()
      for (const line of lines) {
        const header =
          /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):([\t\x20-\x7e\x80-\xff]*)$/.exec(line)
        assert(header, `Invalid HTTP header at ${label}`)
        const name = header[1].toLowerCase()
        assert(!headers.has(name), `Duplicate header ${name} at ${label}`)
        headers.set(name, header[2].replace(/^[ \t]+|[ \t]+$/g, ''))
      }
      assert(
        !headers.has('transfer-encoding'),
        `Unsupported transfer-encoding at ${label}`,
      )
      // HTTP requests without Content-Length/Transfer-Encoding have no body.
      const length = headers.get('content-length') ?? '0'
      assert(/^[0-9]+$/.test(length), `Malformed Content-Length at ${label}`)
      const size = Number(length)
      assert(Number.isSafeInteger(size), `Unsafe Content-Length at ${label}`)
      const start = headerEnd + 4
      assert(size <= stream.length - start, `Partial HTTP body at ${label}`)
      const end = start + size
      const body = decoder.decode(stream.subarray(start, end))
      requests.push({
        sourceType,
        sourceId,
        method,
        target,
        headers: Object.fromEntries(headers),
        body,
      })
      offset = end
    }
  }
  return requests
}
