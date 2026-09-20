import { variable } from '@reatom/core'

import type { OtlpAttrValue } from './toOtlpValue.ts'

/**
 * Frame-scoped runtime override for resource attributes. Set inside an
 * instrumented atom/action to attach extra `service.*` / `deployment.*`
 * metadata to the spans emitted by descendants in the same call tree. Values
 * are merged into the construction-time `resourceAttributes` (var keys win) at
 * queue time as bounded owned snapshots and shipped on the next batch flush.
 * This ambient override is intentionally shared by all adapters in the frame;
 * it does not belong to one adapter's trace context.
 */
export const resourceAttributesVar = variable<Record<string, OtlpAttrValue>>(
  '@reatom/opentelemetry.resourceAttributes',
)
