import { Buffer } from 'node:buffer'

import { action, bind, context } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import { parsePayload } from './test-helpers.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'

const createRun = () =>
  context.start(() => bind(<T>(callback: () => T) => callback()))

const setup = (resourceAttributes: Record<string, OtlpAttrValue> = {}) => {
  const bodies: string[] = []
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'resource-buffer',
    resourceAttributes,
    captureValues: false,
    batchInterval: 100_000,
    maxBatchSize: 10,
    retry: { maxRetries: 0 },
    filter: (target) => target.name.startsWith('resource-buffer.'),
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  return { otel, bodies }
}

test('metadata-only ambient Buffers retain distinct resource groups after late mutation', async () => {
  const first = Buffer.from([1, 2, 3])
  const second = Buffer.from([4, 5, 6])
  const { otel, bodies } = setup()
  const run = createRun()
  try {
    const work = run(() =>
      action((bytes: Uint8Array) => bytes, 'resource-buffer.ambient'),
    )

    expect(
      run(() => resourceAttributesVar.run({ bytes: first }, () => work(first))),
    ).toBe(first)
    expect(
      run(() =>
        resourceAttributesVar.run({ bytes: second }, () => work(second)),
      ),
    ).toBe(second)
    first.fill(9)
    second.fill(9)
    await otel.flush()

    expect(bodies).toHaveLength(1)
    const groups = parsePayload(bodies[0]!).resourceSpans
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.resource.attributes.bytes)).toEqual([
      { bytes: 'AQID' },
      { bytes: 'BAUG' },
    ])
    for (const group of groups) {
      expect(group.spans.map((span) => span.name)).toEqual([
        'resource-buffer.ambient',
      ])
      expect(group.spans[0]!.attributes).toEqual({})
    }
  } finally {
    otel.dispose()
  }
})

class Bytes extends Uint8Array {}

test.each([
  ['Buffer', () => Buffer.from([1, 2, 3])],
  ['Uint8Array', () => new Uint8Array([1, 2, 3])],
  ['Uint8Array subclass', () => new Bytes([1, 2, 3])],
] as const)(
  'metadata-only factory %s bytes are owned from construction',
  async (_kind: string, make: () => Uint8Array) => {
    const bytes = make()
    const { otel, bodies } = setup({ bytes })
    const run = createRun()
    try {
      // Mutate before and after admission: the snapshot must be owned from
      // construction, never aliased to the live source.
      bytes.fill(9)
      const work = run(() =>
        action(() => 'private-factory-payload', 'resource-buffer.factory'),
      )
      expect(run(work)).toBe('private-factory-payload')
      bytes.fill(8)
      await otel.flush()

      expect(bodies).toHaveLength(1)
      const groups = parsePayload(bodies[0]!).resourceSpans
      expect(groups).toHaveLength(1)
      expect(groups[0]!.resource.attributes.bytes).toEqual({ bytes: 'AQID' })
      expect(groups[0]!.spans.map((span) => span.name)).toEqual([
        'resource-buffer.factory',
      ])
      expect(groups[0]!.spans[0]!.attributes).toEqual({})
      expect(bodies[0]).not.toContain('private-factory-payload')
    } finally {
      otel.dispose()
    }
  },
)
