/* global process, console */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const normalize = (value) => {
  if (Array.isArray(value)) return value.map(normalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'test.run_id')
      .map(([key, item]) => [key, normalize(item)]),
  )
}

const read = async (directory, name) =>
  JSON.parse(await readFile(join(directory, 'output', name), 'utf8'))
const [first, second] = process.argv.slice(2)
assert(
  first && second,
  'Usage: compare-runs.mjs FIRST_ARTIFACTS SECOND_ARTIFACTS',
)
const semanticA = normalize(await read(first, 'semantic.json'))
const semanticB = normalize(await read(second, 'semantic.json'))
assert.deepEqual(
  semanticB,
  semanticA,
  'semantic graphs differ between clean runs',
)
const ui = (run) =>
  run.cases.map(({ caseId, app, mode, ui }) => ({ caseId, app, mode, ui }))
assert.deepEqual(
  ui(await read(second, 'run.json')),
  ui(await read(first, 'run.json')),
  'application outcomes differ between clean runs',
)
console.log(
  JSON.stringify({ equal: true, cases: Object.keys(semanticA).length }),
)
