/* global process */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, URL } from 'node:url'

test('container-writable output cannot redirect host metadata writes', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'otel-artifacts-'))
  const artifacts = join(temporary, 'run')
  const victim = join(temporary, 'untouched.txt')
  const bin = join(temporary, 'bin')
  try {
    await mkdir(bin)
    await writeFile(victim, 'original')
    // Replace only Docker: no containers or network. Simulate a symlink planted
    // in its writable mount, then fail image preflight to exercise host cleanup.
    await writeFile(
      join(bin, 'docker'),
      `#!${process.execPath}\nconst fs = require('node:fs');\nconst path = require('node:path');\nfs.symlinkSync(process.env.TEST_VICTIM, path.join(process.env.COLLECTOR_ARTIFACTS, 'host-result.json'));\nprocess.exit(1);\n`,
      { mode: 0o700 },
    )
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./run.mjs', import.meta.url)),
        '--validate-only',
        '--artifacts',
        artifacts,
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          TEST_VICTIM: victim,
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    )
    assert.equal(result.status, 1, result.stderr)
    assert.equal(await readFile(victim, 'utf8'), 'original')
    assert.equal(
      (await stat(artifacts)).mode & 0o077,
      0,
      'host metadata must be private',
    )
    const status = JSON.parse(
      await readFile(join(artifacts, 'host-result.json'), 'utf8'),
    )
    assert.equal(status.success, false)
    assert.match(status.error, /inspect-preloaded-images failed/)
    const commands = JSON.parse(
      await readFile(join(artifacts, 'commands.json'), 'utf8'),
    )
    assert.equal(commands.length, 1)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
