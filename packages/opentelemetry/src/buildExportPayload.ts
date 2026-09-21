import type { OtlpSpan } from './buildSpan.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'
import { toOtlpAttributes } from './toOtlpValue.ts'

export const buildResource = (attributes: Record<string, OtlpAttrValue>) => ({
  attributes: toOtlpAttributes(attributes),
})

const buildInstrumentationScope = (version: string) => ({
  name: '@reatom/opentelemetry',
  version,
})

type ScopeSpansInput = {
  version: string
  spans: OtlpSpan[]
}

// Clone the spans array so later mutations of `input.spans` don't affect the built payload
// (e.g. a batch exporter clearing its queue after build, before retry).
const buildScopeSpans = (input: ScopeSpansInput) => ({
  scope: buildInstrumentationScope(input.version),
  spans: [...input.spans],
})

type ResourceSpansInput = {
  resourceAttributes: Record<string, OtlpAttrValue>
  version: string
  spans: OtlpSpan[]
}

const buildResourceSpans = (input: ResourceSpansInput) => ({
  resource: buildResource(input.resourceAttributes),
  scopeSpans: [buildScopeSpans({ version: input.version, spans: input.spans })],
})

export interface ExportPayloadInput {
  groups: ResourceSpansInput[]
}

export const buildExportPayload = (input: ExportPayloadInput) => ({
  resourceSpans: input.groups.map(buildResourceSpans),
})
