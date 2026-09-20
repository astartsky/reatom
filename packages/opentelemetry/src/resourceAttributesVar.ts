import { variable } from '@reatom/core'

import type { OtlpAttrValue } from './toOtlpValue.ts'

/**
 * Shared Reatom scope override, copied at admission before the action body. Use
 * resourceAttributesVar.run(attributes, callback) around traced calls. Keys
 * override factory defaults; later mutations do not change admitted spans.
 */
export const resourceAttributesVar = variable<Record<string, OtlpAttrValue>>(
  '@reatom/opentelemetry.resourceAttributes',
)
