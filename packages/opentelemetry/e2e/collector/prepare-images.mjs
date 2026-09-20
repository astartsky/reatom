/* global process, console, setTimeout, clearTimeout */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

export const suiteDir = dirname(fileURLToPath(import.meta.url))
const json = (value) => `${JSON.stringify(value, null, 2)}\n`

// Importing these helpers never pulls, builds or starts a container.
export async function buildInputs() {
  const images = JSON.parse(
    await readFile(join(suiteDir, 'images.json'), 'utf8'),
  )
  if (images.schemaVersion !== 1 || images.platform !== 'linux/arm64')
    throw new Error('Unsupported image lock schema/platform')
  for (const key of ['collector', 'playwright']) {
    const entry = images[key]
    if (
      !/^sha256:[a-f0-9]{64}$/.test(entry.manifestDigest) ||
      entry.image !== `${entry.repository}:${entry.tag}@${entry.manifestDigest}`
    )
      throw new Error(`Invalid ${key} digest pin`)
  }
  const files = {
    Dockerfile: await readFile(join(suiteDir, 'Dockerfile'), 'utf8'),
    'package.json': json(images.runner.package),
    'package-lock.json': json(images.runner.lock),
  }
  const hash = createHash('sha256')
    .update(
      json({ platform: images.platform, base: images.playwright.image, files }),
    )
    .digest('hex')
  return {
    images,
    files,
    hash,
    runnerTag: `${images.runner.repository}:pw${images.playwright.version}-arm64-${hash.slice(0, 16)}`,
  }
}

export async function freshArtifacts(requested, prefix) {
  const directory = resolve(
    requested ?? join(tmpdir(), `${prefix}-${randomUUID()}`),
  )
  await mkdir(dirname(directory), { recursive: true })
  // Refuse even an existing empty directory: never truncate older evidence.
  await mkdir(directory)
  return directory
}

export function commandRunner(artifacts, environment = {}) {
  const records = []
  let active
  const execute = async (
    label,
    argv,
    { timeout = 120_000, allowFailure = false } = {},
  ) => {
    const path = join(
      artifacts,
      `${String(records.length + 1).padStart(2, '0')}-${label}.log`,
    )
    const stream = createWriteStream(path, { flags: 'wx' })
    const record = {
      label,
      argv,
      startedAt: new Date().toISOString(),
      log: path,
    }
    records.push(record)
    let stdout = ''
    let timedOut = false
    let killed
    let spawnError
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    active = child
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killed = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      stream.write(chunk)
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stream.write(chunk)
      process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      spawnError = error.message
    })
    const [code, signal] = await new Promise((done) =>
      child.on('close', (...args) => done(args)),
    )
    clearTimeout(timer)
    clearTimeout(killed)
    active = undefined
    await new Promise((done) => stream.end(done))
    Object.assign(record, {
      finishedAt: new Date().toISOString(),
      code,
      signal,
      timedOut,
      spawnError,
    })
    await writeFile(join(artifacts, 'commands.json'), json(records))
    if (!allowFailure && (code !== 0 || signal || timedOut || spawnError))
      throw new Error(
        `${label} failed: code=${code}, signal=${signal}, timeout=${timedOut}; ${path}`,
      )
    return { stdout, ...record }
  }
  execute.interrupt = () => active?.kill('SIGTERM')
  return execute
}

export async function prepareMain() {
  const { values } = parseArgs({
    options: { artifacts: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    console.log(
      'node prepare-images.mjs [--artifacts <new-directory>]\nExplicit online preparation only; context contains exactly Dockerfile/package.json/package-lock.json.',
    )
    return
  }
  const inputs = await buildInputs()
  const artifacts = await freshArtifacts(
    values.artifacts ?? process.env.COLLECTOR_PREP_ARTIFACTS,
    'reatom-collector-prepare',
  )
  console.log(`Preparation artifacts: ${artifacts}`)
  const execute = commandRunner(artifacts)
  await writeFile(join(artifacts, 'inputs.json'), json(inputs))
  const context = join(artifacts, 'build-context')
  await mkdir(context)
  for (const [name, content] of Object.entries(inputs.files))
    await writeFile(join(context, name), content)
  await execute(
    'pull-collector',
    [
      'docker',
      'pull',
      '--platform',
      inputs.images.platform,
      inputs.images.collector.image,
    ],
    { timeout: 900_000 },
  )
  await execute(
    'pull-playwright',
    [
      'docker',
      'pull',
      '--platform',
      inputs.images.platform,
      inputs.images.playwright.image,
    ],
    { timeout: 900_000 },
  )
  await execute(
    'build-runner',
    [
      'docker',
      'build',
      '--platform',
      inputs.images.platform,
      '--pull=false',
      '--progress=plain',
      '--build-arg',
      `PLAYWRIGHT_IMAGE=${inputs.images.playwright.image}`,
      '--build-arg',
      `INPUT_SHA256=${inputs.hash}`,
      '--tag',
      inputs.runnerTag,
      '--iidfile',
      join(artifacts, 'runner.iid'),
      context,
    ],
    { timeout: 900_000 },
  )
  const result = await execute('inspect-images', [
    'docker',
    'image',
    'inspect',
    inputs.images.collector.image,
    inputs.images.playwright.image,
    inputs.runnerTag,
  ])
  const inspected = JSON.parse(result.stdout)
  for (const image of inspected) {
    if (`${image.Os}/${image.Architecture}` !== inputs.images.platform)
      throw new Error(`Unexpected platform for ${image.Id}`)
  }
  if (
    inspected[2].Config.Labels?.['org.reatom.collector.inputs'] !== inputs.hash
  )
    throw new Error('Runner input hash label mismatch')
  if (inspected[0].Config.User !== inputs.images.collector.user)
    throw new Error(
      'Collector UID differs from the reviewed file permission policy',
    )
  await writeFile(
    join(artifacts, 'prepared.json'),
    json({
      platform: inputs.images.platform,
      runnerTag: inputs.runnerTag,
      runnerImageId: inspected[2].Id,
      inputSha256: inputs.hash,
      collector: inputs.images.collector.image,
      playwright: inputs.images.playwright.image,
    }),
  )
  console.log(
    `Prepared runner: ${inputs.runnerTag}\nImage ID: ${inspected[2].Id}`,
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  prepareMain().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
