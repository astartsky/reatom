/* global process, console */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../../..')
const output = resolve(process.argv[2] ?? join(here, 'prepared/apps'))
const dependencies = resolve(
  process.env.COLLECTOR_E2E_DEPS ?? join(root, 'examples/react-search'),
)
const requireDependency = createRequire(join(dependencies, 'package.json'))
const { build } = await import(
  pathToFileURL(requireDependency.resolve('vite')).href
)
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const manifest = { inputs: {}, outputs: {}, coreModules: {} }
const hashOutput = async (directory, prefix) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}/${entry.name}`
    const file = join(directory, entry.name)
    if (entry.isDirectory()) await hashOutput(file, name)
    else manifest.outputs[name] = digest(await readFile(file))
  }
}
manifest.buildConfigHash = digest(
  await readFile(fileURLToPath(import.meta.url)),
)
manifest.workspaceLockHash = digest(
  await readFile(join(root, 'pnpm-lock.yaml')),
)
const core = join(root, 'packages/core/dist/index.js')
const adapter = resolve(
  process.env.COLLECTOR_E2E_ADAPTER ??
    join(root, 'packages/opentelemetry/dist/index.js'),
)

for (const app of ['tree', 'xo', 'search']) {
  const appOut = join(output, app)
  const aliases = [
    { find: /^@reatom\/core$/, replacement: core },
    { find: /^@reatom\/opentelemetry$/, replacement: adapter },
    {
      find: /^@reatom\/jsx(?:\/jsx-runtime)?$/,
      replacement: join(root, 'packages/jsx/dist/index.js'),
    },
    {
      find: /^@reatom\/react$/,
      replacement: join(root, 'packages/react/dist/index.js'),
    },
  ]
  const result = await build({
    configFile: false,
    root,
    base: './',
    logLevel: 'warn',
    define: { __APP__: JSON.stringify(app) },
    resolve: { alias: aliases, dedupe: ['react', 'react-dom', '@reatom/core'] },
    oxc: {
      jsx:
        app === 'search'
          ? { runtime: 'automatic', importSource: 'react' }
          : {
              runtime: 'classic',
              pragma: 'h',
              pragmaFrag: 'hf',
              throwIfNamespace: false,
            },
      ...(app === 'search'
        ? {}
        : { jsxInject: 'import { h, hf } from "@reatom/jsx"' }),
    },
    plugins: [
      {
        name: 'collector-fixture-resolution',
        async resolveId(id) {
          if (id === 'virtual:collector-entry') return '\0collector-entry'
          if (
            /^(react(?:-dom)?(?:\/.*)?|@mantine\/[^/]+(?:\/.*)?|@tabler\/icons-react|zod)$/.test(
              id,
            )
          ) {
            return requireDependency.resolve(id)
          }
        },
        load(id) {
          if (id !== '\0collector-entry') return
          const directory =
            app === 'search' ? 'react-search' : `reatom-jsx-${app}`
          const entry = app === 'search' ? 'main.tsx' : 'index.tsx'
          const model =
            app === 'search' ? 'components/search/model.ts' : 'model.ts'
          return `import ${JSON.stringify(join(root, 'examples', directory, 'src', entry))};\nexport * as model from ${JSON.stringify(join(root, 'examples', directory, 'src', model))};`
        },
        async generateBundle(_options, bundle) {
          const modules = new Set()
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== 'chunk') continue
            for (const id of Object.keys(chunk.modules)) modules.add(id)
          }
          const cores = [...modules].filter((id) =>
            /\/(?:packages\/core|@reatom\/core)\/(src|dist)\//.test(id),
          )
          assert.deepEqual(
            cores,
            [core],
            'All consumers must share the original built core',
          )
          manifest.coreModules[app] = cores
          for (const id of modules) {
            if (id.startsWith(root + '/') && !id.includes('/node_modules/')) {
              manifest.inputs[id.slice(root.length + 1)] = digest(
                await readFile(id),
              )
            }
          }
        },
      },
    ],
    build: {
      outDir: appOut,
      emptyOutDir: true,
      minify: true,
      target: 'esnext',
      sourcemap: true,
      rolldownOptions: {
        input: join(here, 'bootstrap.mjs'),
        output: { entryFileNames: 'bootstrap.js' },
      },
    },
  })
  assert(result)
  await mkdir(appOut, { recursive: true })
  await writeFile(
    join(appOut, 'index.html'),
    '<!doctype html><html><head><meta charset="utf-8"><title>Collector fixture</title></head><body><div id="app"></div><div id="root"></div><script type="module" src="./bootstrap.js"></script></body></html>',
  )
  await hashOutput(appOut, app)
}
manifest.coreHash = digest(await readFile(core))
manifest.adapterHash = digest(await readFile(adapter))
manifest.adapterInput = adapter
await writeFile(
  join(output, 'manifest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
)
console.log(
  JSON.stringify({
    output,
    coreHash: manifest.coreHash,
    adapterHash: manifest.adapterHash,
  }),
)
