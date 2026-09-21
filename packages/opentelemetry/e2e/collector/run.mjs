/* global process, console */

import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import {
  buildInputs,
  commandRunner,
  freshArtifacts,
  suiteDir,
} from './prepare-images.mjs'

const { values } = parseArgs({
  options: {
    artifacts: { type: 'string' },
    apps: { type: 'string' },
    'validate-only': { type: 'boolean' },
    help: { type: 'boolean' },
  },
})
if (values.help) {
  console.log(
    'node run.mjs [--artifacts <new-directory>] [--apps <prepared-apps>] [--validate-only]\nRequires prepare-images.mjs first. Offline run -> graceful Collector stop -> offline verify; evidence survives cleanup.',
  )
} else {
  await main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

async function main() {
  const inputs = await buildInputs()
  const apps = resolve(
    values.apps ??
      process.env.COLLECTOR_APPS ??
      join(suiteDir, 'prepared/apps'),
  )
  if (!values['validate-only']) {
    if (!(await stat(join(suiteDir, 'runner.mjs'))).isFile())
      throw new Error('Missing parent runner.mjs')
    if (!(await stat(apps)).isDirectory())
      throw new Error(`Missing prepared apps: ${apps}`)
    const root = resolve(suiteDir, '../../../..')
    const manifest = JSON.parse(
      await readFile(join(apps, 'manifest.json'), 'utf8'),
    )
    const check = async (file, expected) => {
      const actual = createHash('sha256')
        .update(await readFile(file))
        .digest('hex')
      if (actual !== expected) throw new Error(`Stale app build input: ${file}`)
    }
    for (const [name, hash] of Object.entries(manifest.inputs)) {
      const file = resolve(root, name)
      if (!file.startsWith(root + sep))
        throw new Error('Invalid build input path')
      await check(file, hash)
    }
    await check(join(root, 'pnpm-lock.yaml'), manifest.workspaceLockHash)
    await check(join(root, 'packages/core/dist/index.js'), manifest.coreHash)
    await check(manifest.adapterInput, manifest.adapterHash)
    await check(join(suiteDir, 'build-apps.mjs'), manifest.buildConfigHash)
  }
  const artifacts = await freshArtifacts(
    values.artifacts ?? process.env.COLLECTOR_ARTIFACTS,
    'reatom-collector-run',
  )
  const project = `reatom-otel-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  // Mount only synthetic output. Host metadata stays behind the private parent.
  const output = join(artifacts, 'output')
  await mkdir(output, { mode: 0o777 })
  await chmod(output, 0o777)
  await mkdir(join(output, 'collector'), { mode: 0o777 })
  await chmod(join(output, 'collector'), 0o777)
  console.log(`Collector artifacts: ${artifacts}\nCompose project: ${project}`)
  const environment = {
    COLLECTOR_IMAGE: inputs.images.collector.image,
    COLLECTOR_RUNNER_IMAGE: inputs.runnerTag,
    COLLECTOR_ARTIFACTS: output,
    COLLECTOR_APPS: apps,
    COLLECTOR_RUN_ID: process.env.COLLECTOR_RUN_ID ?? project,
    COLLECTOR_CASE: process.env.COLLECTOR_CASE ?? '',
  }
  const execute = commandRunner(artifacts, environment)
  const compose = [
    'docker',
    'compose',
    '--ansi',
    'never',
    '--env-file',
    '/dev/null',
    '--project-directory',
    suiteDir,
    '-f',
    join(suiteDir, 'compose.yaml'),
    '-p',
    project,
  ]
  const c = (label, args, options) =>
    execute(label, [...compose, ...args], options)
  let interrupted
  const interrupt = (signal) => {
    interrupted = signal
    execute.interrupt()
  }
  const onInt = () => interrupt('SIGINT')
  const onTerm = () => interrupt('SIGTERM')
  process.on('SIGINT', onInt)
  process.on('SIGTERM', onTerm)
  let collectorId
  let collectorStopped = false
  let projectTouched = false
  let failure
  const status = {
    project,
    artifacts,
    apps,
    runId: environment.COLLECTOR_RUN_ID,
    validateOnly: !!values['validate-only'],
    startedAt: new Date().toISOString(),
  }
  const assertUninterrupted = () => {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}`)
  }
  const save = async (name, value) =>
    writeFile(join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`)
  async function stopCollector() {
    if (!collectorId || collectorStopped) return
    await c('stop-collector', ['stop', '--timeout', '30', 'collector'], {
      timeout: 45_000,
    })
    const inspection = await execute('inspect-stopped-collector', [
      'docker',
      'inspect',
      collectorId,
    ])
    const stopped = JSON.parse(inspection.stdout)[0]
    await save('collector-state.json', stopped.State)
    collectorStopped = true
    if (
      stopped.State.Running ||
      stopped.State.OOMKilled ||
      stopped.State.ExitCode !== 0
    )
      throw new Error(
        `Collector did not exit gracefully: ${JSON.stringify(stopped.State)}`,
      )
    // Exit 137 (SIGKILL), OOM, timeout and any other nonzero exit are failures.
  }
  try {
    const inspected = await execute('inspect-preloaded-images', [
      'docker',
      'image',
      'inspect',
      inputs.images.collector.image,
      inputs.runnerTag,
    ])
    const [collector, runner] = JSON.parse(inspected.stdout)
    for (const image of [collector, runner])
      if (`${image.Os}/${image.Architecture}` !== inputs.images.platform)
        throw new Error('Wrong image platform')
    if (collector.Config.User !== inputs.images.collector.user)
      throw new Error('Wrong Collector UID')
    if (runner.Config.Labels?.['org.reatom.collector.inputs'] !== inputs.hash)
      throw new Error(
        'Prepared runner is stale; explicitly rerun prepare-images.mjs',
      )
    // Pin this invocation to immutable local IDs, even if a tag later changes.
    environment.COLLECTOR_IMAGE = collector.Id
    environment.COLLECTOR_RUNNER_IMAGE = runner.Id
    const configHash = createHash('sha256')
      .update(await readFile(join(suiteDir, 'collector.yaml')))
      .digest('hex')
    await save('host-inputs.json', {
      ...status,
      images: inputs.images,
      runnerImageId: runner.Id,
      runnerInputSha256: inputs.hash,
      collectorImageId: collector.Id,
      collectorConfigSha256: configHash,
    })
    const config = JSON.parse(
      (await c('compose-config', ['config', '--format', 'json'])).stdout,
    )
    if (Object.keys(config.services).sort().join(',') !== 'collector,runner')
      throw new Error('Unexpected Compose services')
    for (const service of Object.values(config.services)) {
      if (
        service.ports?.length ||
        service.network_mode ||
        service.privileged ||
        service.build
      )
        throw new Error(
          'Compose must not publish ports, build, or use host/privileged mode',
        )
      if (
        service.platform !== inputs.images.platform ||
        service.pull_policy !== 'never'
      )
        throw new Error('Compose must pin platform and forbid pulls')
    }
    if (!Object.values(config.networks).every((network) => network.internal))
      throw new Error('All Compose networks must be internal')
    assertUninterrupted()
    projectTouched = true
    await c('validate-collector', [
      'run',
      '--rm',
      '--no-deps',
      '--pull',
      'never',
      'collector',
      'validate',
      '--config=/etc/otelcol-contrib/config.yaml',
    ])
    assertUninterrupted()
    if (!values['validate-only']) {
      await c('start-collector', [
        'up',
        '-d',
        '--pull',
        'never',
        '--no-build',
        'collector',
      ])
      collectorId = (
        await c('collector-id', ['ps', '-q', 'collector'])
      ).stdout.trim()
      if (!/^[a-f0-9]{12,64}$/.test(collectorId))
        throw new Error('Collector container ID missing')
      await execute('inspect-network', [
        'docker',
        'network',
        'inspect',
        `${project}_collector_e2e`,
      ])
      const health = `const deadline=Date.now()+20000; let ready=false; while(Date.now()<deadline){try{const r=await fetch('http://collector:13133/',{signal:AbortSignal.timeout(1000)}); await r.arrayBuffer(); if(r.ok){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,100))} if(!ready)throw new Error('Collector health deadline'); console.log('Collector ready')`
      await c(
        'collector-health',
        [
          'run',
          '--rm',
          '--no-deps',
          '--use-aliases',
          '--pull',
          'never',
          'runner',
          'node',
          '--input-type=module',
          '-e',
          health,
        ],
        { timeout: 45_000 },
      )
      assertUninterrupted()
      await c(
        'scenarios',
        [
          'run',
          '--rm',
          '--no-deps',
          '--use-aliases',
          '--pull',
          'never',
          'runner',
          'node',
          '/suite/runner.mjs',
          'run',
        ],
        { timeout: 600_000 },
      )
      assertUninterrupted()
      await stopCollector()
      // Never restart Collector after stop: append:false would erase evidence.
      await c(
        'verify',
        [
          'run',
          '--rm',
          '--no-deps',
          '--use-aliases',
          '--pull',
          'never',
          'runner',
          'node',
          '/suite/runner.mjs',
          'verify',
        ],
        { timeout: 120_000 },
      )
      assertUninterrupted()
    }
  } catch (error) {
    failure = error
  } finally {
    // Cleanup also runs after scenario/health failures and catchable signals.
    if (projectTouched) {
      if (!collectorId) {
        const found = await c(
          'cleanup-collector-id',
          ['ps', '-a', '-q', 'collector'],
          { allowFailure: true },
        )
        const id = found.stdout.trim()
        if (/^[a-f0-9]{12,64}$/.test(id)) collectorId = id
      }
      try {
        await stopCollector()
      } catch (error) {
        failure ??= error
      }
      const logs = await c(
        'compose-logs',
        ['logs', '--no-color', '--timestamps'],
        { allowFailure: true },
      )
      if (logs.code !== 0)
        failure ??= new Error('Could not preserve Compose logs')
      const down = await c(
        'cleanup',
        ['down', '--remove-orphans', '--timeout', '30'],
        { timeout: 60_000, allowFailure: true },
      )
      if (down.code !== 0) failure ??= new Error('Compose cleanup failed')
      const remaining = await execute(
        'cleanup-containers',
        [
          'docker',
          'ps',
          '-aq',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ],
        { allowFailure: true },
      )
      const networks = await execute(
        'cleanup-networks',
        [
          'docker',
          'network',
          'ls',
          '-q',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ],
        { allowFailure: true },
      )
      if (
        remaining.code !== 0 ||
        networks.code !== 0 ||
        remaining.stdout.trim() ||
        networks.stdout.trim()
      )
        failure ??= new Error('Own-project cleanup is incomplete')
    }
    process.off('SIGINT', onInt)
    process.off('SIGTERM', onTerm)
    if (interrupted) failure ??= new Error(`Interrupted by ${interrupted}`)
    await save('host-result.json', {
      ...status,
      finishedAt: new Date().toISOString(),
      collectorStopped,
      success: !failure,
      error: failure?.message,
    })
  }
  if (failure) throw failure
  console.log(
    `${values['validate-only'] ? 'Pinned Collector config validated' : 'Collector scenarios and closed-file verification passed'}; evidence: ${artifacts}`,
  )
}
