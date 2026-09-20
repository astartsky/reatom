import { type AtomLike, context, type Frame } from '@reatom/core'
import { expect, test } from 'vitest'

import { readResourceAttributes } from './readResourceAttributes.ts'
import { resourceAttributesVar } from './resourceAttributesVar.ts'
import type { OtlpAttrValue } from './toOtlpValue.ts'

const frame = (
  pubs: Array<Frame | null> = [null],
  value?: Record<string, OtlpAttrValue>,
  atom = { __reatom: { reactive: true } } as AtomLike,
): Frame => ({
  atom,
  pubs: pubs as Frame['pubs'],
  state: undefined,
  error: null,
  'var#abort': undefined,
  subs: [],
  root: {} as Frame['root'],
  run: (fn, ...params) => fn(...params),
  [resourceAttributesVar.name]: value,
})

test('keeps the original depth-first precedence, including a direct value', () => {
  const first = { which: 'first deep' },
    second = { which: 'second shallow' }
  const root = frame([frame([frame([null], first)]), frame([null], second)])
  expect(readResourceAttributes(root)).toBe(first)
  expect(readResourceAttributes(root)).toBe(resourceAttributesVar.get(root))
  const direct = { which: 'direct' }
  root[resourceAttributesVar.name] = direct
  expect(readResourceAttributes(root)).toBe(direct)
})

test('preserves spawn boundaries and skips context ancestors', () => {
  const hidden = { which: 'hidden' },
    expected = { which: 'visible' }
  const boundary = frame(
    [frame([null], hidden)],
    undefined,
    resourceAttributesVar.spawn,
  )
  const contextFrame = frame([null], hidden, context)
  const root = frame([boundary, contextFrame, frame([null], expected)])
  expect(readResourceAttributes(root)).toBe(expected)
  expect(readResourceAttributes(root)).toBe(resourceAttributesVar.get(root))
  expect(readResourceAttributes(boundary)).toBeUndefined()
})

test('a cyclic branch does not hide a later resource value', () => {
  const expected = { which: 'after cycle' }
  const cycle = frame()
  cycle.pubs = [cycle]
  const root = frame([cycle, frame([null], expected)])
  expect(readResourceAttributes(root)).toBe(expected)
})

test('a cycle without any override terminates with absence', () => {
  const left = frame(),
    right = frame([left])
  left.pubs = [right]
  expect(readResourceAttributes(left)).toBeUndefined()
})
