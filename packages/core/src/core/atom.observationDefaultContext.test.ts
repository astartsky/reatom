import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

test('observation preserves the default meta-cache and separates later stores', () => {
  // The normal test wrapper already starts another context. A fresh process
  // exercises the real default context without resetting shared runtime state.
  const result = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(
          new URL(
            './atom.observationDefaultContext.fixture.ts',
            import.meta.url,
          ),
        ),
      ],
      { encoding: 'utf8', timeout: 5000 },
    ),
  )
  expect(result.initialContexts).toBe(1)
  expect(result.initialMetaOnly).toBe(true)
  expect(result.observed).toEqual([9, 9, 7, 7, 9, 9])
  expect(result.metaPreserved).toBe(true)
  expect(result.defaultStoreUntouched).toBe(true)
  expect(result.secondStoreUntouched).toBe(true)
  expect(result.ordinaryValues).toEqual([7, 6, 9])
})
