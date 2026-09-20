import { Buffer } from 'node:buffer'

import { expect, test, vi } from 'vitest'

import { selectUnloadBatch } from './selectUnloadBatch.ts'

const group = (name: string, detail = '') => ({
  resource: {
    attributes: [{ key: 'service.name', value: { stringValue: name } }],
  },
  scopeSpans: [
    {
      scope: { name: 'selector-test' },
      spans: [
        {
          name,
          attributes: [{ key: 'detail', value: { stringValue: detail } }],
        },
      ],
    },
  ],
})

type Group = ReturnType<typeof group>

const wire = (groups: readonly Group[]) =>
  JSON.stringify({ resourceSpans: groups })

const bytes = (body: string) => Buffer.byteLength(body, 'utf8')

const names = (body: string): string[] =>
  JSON.parse(body).resourceSpans.flatMap((entry: Group) =>
    entry.scopeSpans.flatMap((scope) => scope.spans.map((span) => span.name)),
  )

test('preserves complete resource groups and original order in one envelope', () => {
  const items = [group('older'), group('newer')]
  const calls: Group[] = []
  const result = selectUnloadBatch({
    items,
    maxBytes: 60 * 1024,
    encode: (item) => {
      calls.push(item)
      return JSON.stringify(item)
    },
  })

  expect(result).toEqual({ body: wire(items), keptCount: 2, droppedCount: 0 })
  expect(names(result.body)).toEqual(['older', 'newer'])
  expect(calls).toEqual([items[1], items[0]])
})

test('keeps the newest fitting suffix without changing the input records', () => {
  const items = Object.freeze([
    group('oldest'),
    group('middle'),
    group('newest'),
  ])
  const before = structuredClone(items)
  const expected = wire([items[1]!, items[2]!])
  const result = selectUnloadBatch({
    items,
    maxBytes: bytes(expected),
    encode: (item) => JSON.stringify(item),
  })

  expect(result).toEqual({ body: expected, keptCount: 2, droppedCount: 1 })
  expect(names(result.body)).toEqual(['middle', 'newest'])
  expect(items).toEqual(before)
})

test.each([-1, 0, 1])(
  'counts UTF-8, JSON escapes, commas and the envelope at boundary %i',
  (offset: number) => {
    const items = [
      group('older-é', '漢字💥\u0000\n\t"\\'),
      group('newer-界', 'é💥\b\r"\\'),
    ]
    const full = wire(items)
    const maxBytes = bytes(full) + offset
    const result = selectUnloadBatch({
      items,
      maxBytes,
      encode: (item) => JSON.stringify(item),
    })

    expect(bytes(full)).toBeGreaterThan(full.length)
    expect(full).toContain('\\u0000')
    expect(result).toEqual({
      body: offset < 0 ? wire([items[1]!]) : full,
      keptCount: offset < 0 ? 1 : 2,
      droppedCount: offset < 0 ? 1 : 0,
    })
    expect(names(result.body)).toEqual(
      offset < 0 ? ['newer-界'] : ['older-é', 'newer-界'],
    )
    expect(bytes(result.body)).toBeLessThanOrEqual(maxBytes)
  },
)

test.each([-1, 0])(
  'a single group requires its full envelope at boundary %i',
  (offset: number) => {
    const items = [group('only')]
    const body = wire(items)
    const result = selectUnloadBatch({
      items,
      maxBytes: bytes(body) + offset,
      encode: (item) => JSON.stringify(item),
    })

    expect(result).toEqual(
      offset < 0
        ? { body: '', keptCount: 0, droppedCount: 1 }
        : { body, keptCount: 1, droppedCount: 0 },
    )
  },
)

test('skips an individually oversized newest group and keeps older eligible groups', () => {
  const items = [
    group('oldest'),
    group('middle'),
    group('oversized-newest', '界'.repeat(1000)),
  ]
  const expected = wire(items.slice(0, 2))
  const calls: Group[] = []
  const result = selectUnloadBatch({
    items,
    maxBytes: bytes(expected),
    encode: (item) => {
      calls.push(item)
      return JSON.stringify(item)
    },
  })

  expect(result).toEqual({ body: expected, keptCount: 2, droppedCount: 1 })
  expect(names(result.body)).toEqual(['oldest', 'middle'])
  expect(calls).toEqual([items[2], items[1], items[0]])
})

test('skips an oversized middle group without breaking the eligible suffix', () => {
  const items = [
    group('oldest'),
    group('oversized-middle', 'x'.repeat(2000)),
    group('newest'),
  ]
  const expected = wire([items[0]!, items[2]!])
  const result = selectUnloadBatch({
    items,
    maxBytes: bytes(expected),
    encode: (item) => JSON.stringify(item),
  })

  expect(result).toEqual({ body: expected, keptCount: 2, droppedCount: 1 })
  expect(names(result.body)).toEqual(['oldest', 'newest'])
})

test('stops at an eligible group that cannot fit rather than searching for smaller older groups', () => {
  const items = [
    group('oldest'),
    group('middle', 'x'.repeat(200)),
    group('newest', 'y'.repeat(50)),
  ]
  const maxBytes = bytes(wire([items[0]!, items[2]!]))
  const calls: Group[] = []
  const result = selectUnloadBatch({
    items,
    maxBytes,
    encode: (item) => {
      calls.push(item)
      return JSON.stringify(item)
    },
  })

  // Middle is individually eligible, while oldest could fit beside newest.
  expect(bytes(wire([items[1]!]))).toBeLessThanOrEqual(maxBytes)
  expect(bytes(wire([items[1]!, items[2]!]))).toBeGreaterThan(maxBytes)
  expect(result).toEqual({
    body: wire([items[2]!]),
    keptCount: 1,
    droppedCount: 2,
  })
  expect(names(result.body)).toEqual(['newest'])
  expect(calls).toEqual([items[2], items[1]])
})

test('returns no body for empty input without calling the encoder', () => {
  let calls = 0
  const result = selectUnloadBatch({
    items: [],
    maxBytes: 60 * 1024,
    encode: () => {
      calls++
      throw new Error('unexpected encoding')
    },
  })

  expect(result).toEqual({ body: '', keptCount: 0, droppedCount: 0 })
  expect(calls).toBe(0)
})

test.each([0, 1, 19, 20, -1, NaN, Infinity, -Infinity])(
  'returns no body without encoding when budget %s cannot hold a group',
  (maxBytes: number) => {
    let calls = 0
    const result = selectUnloadBatch({
      items: [group('older'), group('newer')],
      maxBytes,
      encode: () => {
        calls++
        throw new Error('unexpected encoding')
      },
    })

    expect(result).toEqual({ body: '', keptCount: 0, droppedCount: 2 })
    expect(calls).toBe(0)
  },
)

test('accounts for every individually oversized group without an empty envelope body', () => {
  const items = [
    group('older', 'x'.repeat(100)),
    group('newer', 'y'.repeat(100)),
  ]
  const calls: Group[] = []
  const result = selectUnloadBatch({
    items,
    maxBytes: 30,
    encode: (item) => {
      calls.push(item)
      return JSON.stringify(item)
    },
  })

  expect(result).toEqual({ body: '', keptCount: 0, droppedCount: 2 })
  expect(calls).toEqual([items[1], items[0]])
})

test('propagates the exact encoder error after a selected group and stops encoding', () => {
  const items = [group('oldest'), group('throws'), group('newest')]
  const failure = new Error('encoding failed')
  const calls: Group[] = []
  let returned = false
  let caught: unknown
  try {
    selectUnloadBatch({
      items,
      maxBytes: 60 * 1024,
      encode: (item) => {
        calls.push(item)
        if (item === items[1]) throw failure
        return JSON.stringify(item)
      },
    })
    returned = true
  } catch (error) {
    caught = error
  }

  expect(returned).toBe(false)
  expect(caught).toBe(failure)
  expect(calls).toEqual([items[2], items[1]])
})

test('a large queue encodes each considered record once without whole-payload re-encoding', () => {
  const items = Object.freeze(
    Array.from({ length: 10_000 }, (_, index) =>
      group(`span-${String(index).padStart(5, '0')}`),
    ),
  )
  const expected = wire(items.slice(-100))
  const maxBytes = bytes(expected)
  const stringify = vi.spyOn(JSON, 'stringify')
  let result: ReturnType<typeof selectUnloadBatch>
  let encoded: unknown[]
  try {
    result = selectUnloadBatch({
      items,
      maxBytes,
      encode: (item) => JSON.stringify(item),
    })
    encoded = stringify.mock.calls.map(([value]) => value)
  } finally {
    stringify.mockRestore()
  }

  expect(maxBytes).toBeLessThanOrEqual(60 * 1024)
  expect(result.keptCount).toBe(100)
  expect(result.droppedCount).toBe(9900)
  expect(result.body).toBe(expected)
  expect(names(result.body)).toHaveLength(100)
  expect(names(result.body)[0]).toBe('span-09900')
  expect(names(result.body).at(-1)).toBe('span-09999')
  expect(bytes(result.body)).toBe(maxBytes)
  expect(encoded).toEqual(items.slice(-101).reverse())
  expect(
    encoded.every((item, index) => item === items[items.length - 1 - index]),
  ).toBe(true)
  expect(new Set(encoded).size).toBe(encoded.length)
  expect(encoded.length).toBeLessThanOrEqual(items.length)
  expect(result.keptCount + result.droppedCount).toBe(items.length)
})
