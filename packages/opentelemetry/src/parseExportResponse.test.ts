import { expect, test } from 'vitest'

import { parseExportResponse } from './parseExportResponse.ts'

test.each([
  ['', 5, { accepted: 5, rejected: 0 }],
  [
    '{"partialSuccess":{"rejectedSpans":"0004"}}',
    5,
    { accepted: 1, rejected: 4 },
  ],
  [
    '{"partialSuccess":{"rejectedSpans":"9007199254740991"}}',
    Number.MAX_SAFE_INTEGER,
    { accepted: 0, rejected: Number.MAX_SAFE_INTEGER },
  ],
  ['{}', 5, { accepted: 5, rejected: 0 }],
  ['{"partialSuccess":{}}', 5, { accepted: 5, rejected: 0 }],
  ['{"partialSuccess":{"rejectedSpans":4}}', 5, { accepted: 1, rejected: 4 }],
  [
    '{"partialSuccess":{"rejectedSpans":"4","errorMessage":"hint"}}',
    5,
    { accepted: 1, rejected: 4, errorMessage: 'hint' },
  ],
  [
    '{"partialSuccess":{"rejectedSpans":0,"errorMessage":"warning"}}',
    5,
    { accepted: 5, rejected: 0, errorMessage: 'warning' },
  ],
  [
    `{"partialSuccess":{"rejectedSpans":${Number.MAX_SAFE_INTEGER}}}`,
    Number.MAX_SAFE_INTEGER,
    { accepted: 0, rejected: Number.MAX_SAFE_INTEGER },
  ],
] as const)(
  'accepts valid OTLP response %s',
  (
    text: string,
    keptCount: number,
    expected: { accepted: number; rejected: number; errorMessage?: string },
  ) => {
    expect(parseExportResponse(text, keptCount)).toEqual(expected)
  },
)

test.each([
  ['malformed JSON', '{'],
  ['nonempty whitespace body', '  \n'],
  ['null top-level', 'null'],
  ['array top-level', '[]'],
  ['scalar top-level', '1'],
  ['null partialSuccess', '{"partialSuccess":null}'],
  ['array partialSuccess', '{"partialSuccess":[]}'],
  ['non-string error message', '{"partialSuccess":{"errorMessage":1}}'],
  ['negative JSON number', '{"partialSuccess":{"rejectedSpans":-1}}'],
  ['fractional JSON number', '{"partialSuccess":{"rejectedSpans":1.5}}'],
  [
    'unsafe JSON number',
    '{"partialSuccess":{"rejectedSpans":9007199254740992}}',
  ],
  [
    'rejected JSON number above kept count',
    '{"partialSuccess":{"rejectedSpans":6}}',
  ],
  ['negative string', '{"partialSuccess":{"rejectedSpans":"-1"}}'],
  ['fractional string', '{"partialSuccess":{"rejectedSpans":"1.5"}}'],
  ['non-decimal string', '{"partialSuccess":{"rejectedSpans":"0x4"}}'],
  [
    '2^53 decimal string above kept count',
    '{"partialSuccess":{"rejectedSpans":"9007199254740992"}}',
  ],
  [
    'int64 maximum above kept count',
    '{"partialSuccess":{"rejectedSpans":"9223372036854775807"}}',
  ],
  [
    'int64 overflow',
    '{"partialSuccess":{"rejectedSpans":"9223372036854775808"}}',
  ],
] as const)(
  'rejects %s without reflecting body content',
  (_label: string, text: string) => {
    expect(() => parseExportResponse(text, 5)).toThrow(
      'Invalid OTLP export response',
    )
    expect(() => parseExportResponse(text, 5)).not.toThrow('rejectedSpans')
  },
)

test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid keptCount=%s',
  (keptCount: number) => {
    expect(() => parseExportResponse('{}', keptCount)).toThrow(
      'Invalid OTLP export response',
    )
  },
)
