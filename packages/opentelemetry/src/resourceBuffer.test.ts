import { Buffer } from 'node:buffer'

import { action, bind, context } from '@reatom/core'
import { expect, test } from 'vitest'

import type { OtlpSpan } from './buildSpan.ts'
import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import type { OtlpAnyValue, OtlpAttrValue } from './toOtlpValue.ts'

interface ResourceGroup {
  resource: { attributes: Array<{ key: string; value: OtlpAnyValue }> }
  scopeSpans: Array<{ spans: OtlpSpan[] }>
}

const resourceGroups = (body: string): ResourceGroup[] =>
  JSON.parse(body).resourceSpans

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

test('metadata-only factory Buffer is an owned snapshot from construction', async () => {
  const bytes = Buffer.from([1, 2, 3])
  const { otel, bodies } = setup({ bytes })
  const run = createRun()
  try {
    bytes.fill(9)
    const work = run(() =>
      action(() => 'private-factory-payload', 'resource-buffer.factory'),
    )
    expect(run(work)).toBe('private-factory-payload')
    bytes.fill(8)
    await otel.flush()

    expect(bodies).toHaveLength(1)
    const groups = resourceGroups(bodies[0]!)
    expect(groups).toHaveLength(1)
    expect(
      groups[0]!.resource.attributes.find((entry) => entry.key === 'bytes')
        ?.value,
    ).toEqual({ bytesValue: 'AQID' })
    const spans = groups[0]!.scopeSpans.flatMap((scope) => scope.spans)
    expect(spans.map((span) => span.name)).toEqual(['resource-buffer.factory'])
    expect(spans[0]!.attributes).toEqual([])
    expect(bodies[0]).not.toContain('private-factory-payload')
  } finally {
    otel.dispose()
  }
})

test('metadata-only ambient Buffers retain distinct resource groups after late mutation', async () => {
  const first = Buffer.from([1, 2, 3])
  const second = Buffer.from([4, 5, 6])
  const { otel, bodies } = setup()
  const run = createRun()
  try {
    const work = run(() =>
      action((bytes: Uint8Array) => {
        resourceAttributesVar.set({ bytes })
        return bytes
      }, 'resource-buffer.ambient'),
    )

    expect(run(() => work(first)) === first).toBe(true)
    expect(run(() => work(second)) === second).toBe(true)
    first.fill(9)
    second.fill(9)
    await otel.flush()

    expect(bodies).toHaveLength(1)
    const groups = resourceGroups(bodies[0]!)
    expect(groups).toHaveLength(2)
    expect(
      groups.map(
        (group) =>
          group.resource.attributes.find((entry) => entry.key === 'bytes')
            ?.value,
      ),
    ).toEqual([{ bytesValue: 'AQID' }, { bytesValue: 'BAUG' }])
    for (const group of groups) {
      const spans = group.scopeSpans.flatMap((scope) => scope.spans)
      expect(spans.map((span) => span.name)).toEqual([
        'resource-buffer.ambient',
      ])
      expect(spans[0]!.attributes).toEqual([])
    }
  } finally {
    otel.dispose()
  }
})

class Bytes extends Uint8Array {}

test.each([
  ['Uint8Array', () => new Uint8Array([1, 2, 3])],
  ['Uint8Array subclass', () => new Bytes([1, 2, 3])],
] as const)(
  'metadata-only factory %s keeps its bytes after source mutation',
  async (_kind: string, make: () => Uint8Array) => {
    const bytes = make()
    const { otel, bodies } = setup({ bytes })
    const run = createRun()
    try {
      const work = run(() => action(() => 'ok', 'resource-buffer.control'))
      expect(run(work)).toBe('ok')
      bytes.fill(9)
      await otel.flush()

      expect(bodies).toHaveLength(1)
      const groups = resourceGroups(bodies[0]!)
      expect(groups).toHaveLength(1)
      expect(
        groups[0]!.resource.attributes.find((entry) => entry.key === 'bytes')
          ?.value,
      ).toEqual({ bytesValue: 'AQID' })
      expect(
        groups[0]!.scopeSpans
          .flatMap((scope) => scope.spans)
          .map((span) => span.attributes),
      ).toEqual([[]])
    } finally {
      otel.dispose()
    }
  },
)
