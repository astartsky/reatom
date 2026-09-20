import { context, type Frame, top } from '@reatom/core'

import { resourceAttributesVar } from './resourceAttributesVar.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'

// Keep this variable's depth-first lookup and spawn boundary without revisiting
// cyclic reactive frames. This does not change application Variable methods.
export const readResourceAttributes = (
  frame: Frame = top(),
): Record<string, OtlpAttrValue> | undefined => {
  const visited = new Set<Frame>()
  const stack: Array<{ frame: Frame; next: number }> = [{ frame, next: -1 }]
  while (stack.length) {
    const current = stack[stack.length - 1]!
    if (current.next === -1) {
      if (visited.has(current.frame)) {
        stack.pop()
        continue
      }
      visited.add(current.frame)
      const value = current.frame[resourceAttributesVar.name]
      if (value !== undefined) return value as Record<string, OtlpAttrValue>
      if (current.frame.atom === resourceAttributesVar.spawn) {
        stack.pop()
        continue
      }
      current.next = 0
    }
    if (current.next === current.frame.pubs.length) {
      stack.pop()
      continue
    }
    const pub = current.frame.pubs[current.next++]
    if (pub && pub.atom !== context) stack.push({ frame: pub, next: -1 })
  }
  return undefined
}
