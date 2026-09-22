import { action, bind, context } from '@reatom/core'
import { expect, test } from 'vitest'

import { reatomOpentelemetry } from './reatomOpentelemetry.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import { parsePayload, parseSpans } from './test-helpers.ts'

const createRun = () =>
  context.start(() => bind(<T>(callback: () => T) => callback()))

test('R12 shares ambient resource override across adapters but owns both resource snapshots', async () => {
  const aBodies: string[] = []
  const bBodies: string[] = []
  const run = createRun()
  const makeAdapter = (
    serviceName: string,
    factory: string,
    bodies: string[],
  ) =>
    reatomOpentelemetry({
      endpoint: 'https://collector.invalid',
      serviceName,
      resourceAttributes: { factory },
      filter: (target) => target.name.startsWith('resource-policy.r12'),
      batchInterval: 100_000,
      maxBatchSize: 10,
      retry: { maxRetries: 0 },
      fetch: async (_url, init) => {
        bodies.push(String(init?.body))
        return new Response(null)
      },
    })
  const a = makeAdapter('resource-policy-a', 'R12_factory_a', aBodies)
  const b = makeAdapter('resource-policy-b', 'R12_factory_b', bBodies)
  const override = {
    tenant: { nested: 'R12_override_nested_original' },
    array: ['R12_override_array_original'],
    bytes: new Uint8Array([1, 2, 3]),
  }
  try {
    const [overridden, defaults] = run(() => [
      action(() => 'R12_override_app_value', 'resource-policy.r12-overridden'),
      action(() => 'R12_defaults_app_value', 'resource-policy.r12-defaults'),
    ])

    expect(run(() => resourceAttributesVar.run(override, overridden))).toBe(
      'R12_override_app_value',
    )
    override.tenant.nested = 'R12_override_nested_late'
    override.array[0] = 'R12_override_array_late'
    override.bytes.fill(9)
    expect(run(defaults)).toBe('R12_defaults_app_value')

    await Promise.all([a.flush(), b.flush()])
    const resourceFor = (body: string, name: string) => {
      const group = parsePayload(body).resourceSpans.find((candidate) =>
        candidate.spans.some((span) => span.name === name),
      )
      expect(group?.spans.map((span) => span.name)).toEqual([name])
      return group?.resource.attributes
    }
    for (const [bodies, serviceName, factory] of [
      [aBodies, 'resource-policy-a', 'R12_factory_a'],
      [bBodies, 'resource-policy-b', 'R12_factory_b'],
    ] as const) {
      expect(bodies).toHaveLength(1)
      const payload = parsePayload(bodies[0]!)
      expect(payload.resourceSpans).toHaveLength(2)
      expect(
        parseSpans(bodies[0]!)
          .map((span) => span.name)
          .sort(),
      ).toEqual([
        'resource-policy.r12-defaults',
        'resource-policy.r12-overridden',
      ])
      expect(resourceFor(bodies[0]!, 'resource-policy.r12-overridden')).toEqual(
        {
          'service.name': serviceName,
          factory,
          tenant: { nested: 'R12_override_nested_original' },
          array: ['R12_override_array_original'],
          bytes: { bytes: 'AQID' },
        },
      )
      expect(resourceFor(bodies[0]!, 'resource-policy.r12-defaults')).toEqual({
        'service.name': serviceName,
        factory,
      })
    }
  } finally {
    a.dispose()
    b.dispose()
  }
})

test('auto instrumentation skips hidden names while explicit withOTel opts in once', async () => {
  const bodies: string[] = []
  const run = createRun()
  const otel = reatomOpentelemetry({
    endpoint: 'https://collector.invalid',
    serviceName: 'resource-policy-hidden',
    filter: () => true,
    batchInterval: 100_000,
    maxBatchSize: 10,
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      bodies.push(String(init?.body))
      return new Response(null)
    },
  })
  try {
    const [prefixHidden, segmentHidden, visible] = run(() => [
      action(() => 'R12_hidden_prefix_app_value', '_resource-policy.hidden'),
      action(() => 'R12_hidden_segment_app_value', 'resource-policy._hidden'),
      action(() => 'R12_visible_app_value', 'resource-policy.visible'),
    ])

    expect(run(prefixHidden)).toBe('R12_hidden_prefix_app_value')
    expect(run(segmentHidden)).toBe('R12_hidden_segment_app_value')
    expect(run(visible)).toBe('R12_visible_app_value')
    await otel.flush()
    expect(bodies.flatMap(parseSpans).map((span) => span.name)).toEqual([
      'resource-policy.visible',
    ])

    expect(prefixHidden.extend(otel.withOTel())).toBe(prefixHidden)
    expect(prefixHidden.extend(otel.withOTel())).toBe(prefixHidden)
    expect(run(prefixHidden)).toBe('R12_hidden_prefix_app_value')
    await otel.flush()
    expect(bodies.flatMap(parseSpans).map((span) => span.name)).toEqual([
      'resource-policy.visible',
      '_resource-policy.hidden',
    ])
  } finally {
    otel.dispose()
  }
})
