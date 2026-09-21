/* global URL, document, window, Node, console */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const APPS = new Set(['tree', 'xo', 'search'])
const collectorUrl = /^http:\/\/collector:(?:4318|4319)\/v1\/traces$/
const githubSearch = /^https:\/\/api\.github\.com\/search\/issues\?/
const githubRepo = 'https://api.github.com/repos/reatom/reatom'

const assertStats = (stats, { deliveryExpected }) => {
  assert(stats, 'traced case must expose telemetry stats')
  assert.equal(stats.active, 0, 'active reservations must settle')
  assert.equal(stats.queued, 0, 'queued records must settle after flush')
  assert.equal(stats.inFlight, 0, 'in-flight records must settle after flush')
  if (deliveryExpected) assert.equal(stats.dropped, 0, 'loss-free case dropped')
  else assert(stats.dropped > 0, 'failed delivery must be observable as drop')
}

const isExpectedDeliveryDiagnostic = (error) =>
  /^console:.*(?:collector|CORS|Failed to fetch|NetworkError)/i.test(error)

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const issue = (title, number) => ({
  id: number,
  number,
  title,
  body: `body ${title}`,
  state: 'open',
  html_url: `https://github.com/reatom/reatom/issues/${number}`,
  user: { login: 'fixture', id: number, avatar_url: '', html_url: '' },
  labels: [],
  comments: 0,
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
  repository_url: 'https://api.github.com/repos/reatom/reatom',
})

const issues = (title, number = 1) => ({
  total_count: 20,
  incomplete_results: false,
  items: [issue(title, number)],
})

const appUrl = (origin, app, mode, caseId, runId, query = '') =>
  `${origin}/${app}/?mode=${mode}&case=${encodeURIComponent(caseId)}&run=${encodeURIComponent(runId)}${query}`

const snapshot = (page) => page.evaluate(() => window.collectorTest.snapshot())
const controls = (page, method, ...args) =>
  page.evaluate(
    ([name, parameters]) => window.collectorTest[name](...parameters),
    [method, args],
  )

const installPolicy = async (page, errors, searchQueue) => {
  const expectedHttpErrors = new Map()
  // Never intercept an OTLP request. Deny only URLs outside the two app API
  // fixtures and the isolated runner/Collector origins.
  await page.route(
    /^(?!http:\/\/(?:runner:417[34]\/|collector:(?:4318|4319)\/v1\/traces$)|https:\/\/api\.github\.com\/(?:search\/issues\?|repos\/reatom\/reatom$))https?:\/\//,
    async (route) => {
      errors.push(`blocked unexpected request: ${route.request().url()}`)
      await route.abort('blockedbyclient')
    },
  )
  await page.route('https://api.github.com/search/issues?**', async (route) => {
    const url = new URL(route.request().url())
    const query = url.searchParams.get('q') ?? ''
    const entry = searchQueue.shift() ?? {
      body: issues(
        `${query.split(' ')[0]} page ${url.searchParams.get('page')}`,
      ),
    }
    entry.started?.resolve(route.request())
    await entry.gate?.promise
    if (entry.status && entry.status >= 400) {
      expectedHttpErrors.set(url.href, entry.status)
      await route.fulfill({
        status: entry.status,
        body: JSON.stringify(entry.body ?? { message: 'Fixture failure' }),
      })
      return
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        entry.body ?? issues(`${query} page ${url.searchParams.get('page')}`),
      ),
    })
  })
  await page.route(githubRepo, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        stargazers_count: 1,
        forks_count: 1,
        open_issues_count: 1,
      }),
    }),
  )
  page.on('request', (request) => {
    const url = request.url()
    if (
      collectorUrl.test(url) ||
      url.startsWith('http://runner:4173/') ||
      url.startsWith('http://runner:4174/') ||
      githubSearch.test(url) ||
      url === githubRepo
    )
      return
    if (/^(data|blob):/.test(url)) return
    errors.push(`unexpected request: ${url}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const url = message.location().url
    const status = expectedHttpErrors.get(url)
    if (
      status &&
      message
        .text()
        .startsWith(
          `Failed to load resource: the server responded with a status of ${status} `,
        )
    ) {
      console.log(
        JSON.stringify({ expectedHttpDiagnostic: message.text(), url }),
      )
      return
    }
    errors.push(`console: ${message.text()} @ ${url}`)
  })
}

const createPage = async (browser, errors, searchQueue, captureBody = true) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  await context.addInitScript(() => {
    let state = 0x9e3779b9
    Math.random = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 2 ** 32
    }
  })
  const page = await context.newPage()
  const wireBodies = []
  const wireRequests = []
  const wireReads = []
  const session = await context.newCDPSession(page)
  await session.send('Network.enable')
  session.on('Network.requestWillBeSent', ({ requestId, request }) => {
    if (!collectorUrl.test(request.url) || request.method !== 'POST') return
    wireRequests.push({ url: request.url, method: request.method })
    if (!captureBody) return
    const index = wireBodies.length
    wireBodies.push('')
    const read = (async () => {
      const body =
        request.postData ??
        (await session.send('Network.getRequestPostData', { requestId }))
          .postData
      assert(body, 'Collector request payload must be observable')
      wireBodies[index] = body
    })()
    read.catch(() => {})
    wireReads.push(read)
  })
  const waitForWire = () => Promise.all(wireReads)
  await installPolicy(page, errors, searchQueue)
  return { context, page, wireBodies, wireRequests, waitForWire }
}

const snapshotTree = (page) =>
  page.evaluate(() => {
    const boxes = [...document.querySelectorAll('main input[type="checkbox"]')]
    const readNode = (box) => {
      const element = box.parentElement
      const ownText = [...element.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent)
        .join('')
      const id = ownText.match(/\(([^()]+)\)/)?.[1]
      if (!id) throw new Error('Tree node is missing its rendered ID')
      const children = [
        ...element.querySelectorAll(
          ':scope > ul > li > div > input[type="checkbox"]',
        ),
      ].map(readNode)
      return {
        id,
        index: boxes.indexOf(box),
        checked: box.checked,
        indeterminate: box.indeterminate,
        children,
      }
    }
    if (!boxes[0]) throw new Error('Tree root checkbox is missing')
    return readNode(boxes[0])
  })

const flattenTree = (tree) => [tree, ...tree.children.flatMap(flattenTree)]

const treeNode = (tree, id) => {
  const node = flattenTree(tree).find((candidate) => candidate.id === id)
  assert(node, `tree node ${id} is missing`)
  return node
}

const assertTreeState = (tree, id, checked, indeterminate) => {
  const node = treeNode(tree, id)
  assert.equal(node.checked, checked, `${id}: unexpected checked state`)
  assert.equal(
    node.indeterminate,
    indeterminate,
    `${id}: unexpected indeterminate state`,
  )
}

const assertSevenNodeTopology = (tree) => {
  assert.equal(flattenTree(tree).length, 7, 'Build 7 must replace default 16')
  assert.equal(tree.children.length, 2, 'root must have two source children')
  for (const branch of tree.children) {
    assert.equal(
      branch.children.length,
      2,
      'each source branch must have two source leaves',
    )
    for (const leaf of branch.children)
      assert.equal(leaf.children.length, 0, 'source leaf must have no children')
  }
}

const assertAllTreeState = (tree, checked, indeterminate) => {
  for (const node of flattenTree(tree))
    assertTreeState(tree, node.id, checked, indeterminate)
}

const expectTree = async (page) => {
  const boxes = page.locator('main input[type="checkbox"]')
  assert.equal(await boxes.count(), 16, 'default tree must start with 16 nodes')
  await page.locator('input[type="number"]').fill('7')
  await page.getByRole('button', { name: 'Build', exact: true }).click()
  await page.waitForFunction(
    () => document.querySelectorAll('main input[type="checkbox"]').length === 7,
  )

  const built = await snapshotTree(page)
  assertSevenNodeTopology(built)
  assertAllTreeState(built, true, false)
  const leafId = built.children[0].children[0].id
  const sourceIds = new Set(flattenTree(built).map((node) => node.id))
  const recursiveEdges = flattenTree(built).flatMap((node) =>
    node.children.map((child) => ({ parent: node.id, child: child.id })),
  )

  await boxes.nth(built.index).click()
  await page.waitForFunction(
    () => !document.querySelector('main input[type="checkbox"]')?.checked,
  )
  const afterRootToggle = await snapshotTree(page)
  assertAllTreeState(afterRootToggle, false, false)

  await boxes.nth(treeNode(afterRootToggle, leafId).index).click()
  const afterLeafToggle = await snapshotTree(page)
  assertTreeState(afterLeafToggle, leafId, true, false)
  assertTreeState(afterLeafToggle, afterLeafToggle.children[0].id, false, true)
  assertTreeState(afterLeafToggle, afterLeafToggle.id, false, true)
  assertTreeState(afterLeafToggle, afterLeafToggle.children[1].id, false, false)

  await page.locator('input[placeholder="Name"]').first().fill('branch')
  await page.getByRole('button', { name: '+', exact: true }).first().click()
  await page.waitForFunction(
    () => document.querySelectorAll('main input[type="checkbox"]').length === 8,
  )
  const afterAdd = await snapshotTree(page)
  const added = afterAdd.children.find((child) => !sourceIds.has(child.id))
  assert(added, 'root add must create a distinct branch')
  assert.equal(added.children.length, 0, 'added branch must start as a leaf')
  assertTreeState(afterAdd, added.id, true, false)
  assertTreeState(afterAdd, afterAdd.id, false, true)

  await page
    .getByRole('button', { name: '-', exact: true })
    .nth(added.index)
    .click()
  await page.waitForFunction(
    () => document.querySelectorAll('main input[type="checkbox"]').length === 7,
  )
  const afterDelete = await snapshotTree(page)
  assert.deepEqual(
    afterDelete,
    afterLeafToggle,
    'delete must restore the pre-add source tree and its checked states',
  )

  return {
    built,
    afterRootToggle,
    afterLeafToggle,
    afterAdd,
    afterDelete,
    trace: { leafId, addedId: added.id, recursiveEdges },
  }
}

const cell = (page, index) =>
  page.getByRole('button', {
    name: [
      'Top left cell',
      'Top center cell',
      'Top right cell',
      'Middle left cell',
      'Center cell',
      'Middle right cell',
      'Bottom left cell',
      'Bottom center cell',
      'Bottom right cell',
    ][index],
  })

const physicalClick = async (locator, page) => {
  const box = await locator.boundingBox()
  assert(box, 'physical click target must be visible')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
}

const expectHumanXo = async (page) => {
  await cell(page, 0).click()
  let state = await snapshot(page)
  assert.deepEqual(state.board, [
    'X',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ])
  assert.equal(state.player, 'O')
  assert.equal(state.winner, 'none')
  assert.equal(await cell(page, 0).isDisabled(), true)
  const beforeDisabled = await controls(page, 'stats')
  await physicalClick(cell(page, 0), page)
  assert.deepEqual(
    await snapshot(page),
    state,
    'disabled occupied click must not alter UI',
  )
  const afterDisabled = await controls(page, 'stats')
  if (beforeDisabled) {
    assert.equal(
      afterDisabled.queued,
      beforeDisabled.queued,
      'disabled physical click must not emit makeMove',
    )
  }
  const beforeDirect = afterDisabled
  await controls(page, 'occupiedMove')
  assert.deepEqual(
    await snapshot(page),
    state,
    'original occupiedMove must be a no-op before victory',
  )
  const afterDirect = await controls(page, 'stats')
  if (beforeDirect) {
    assert.equal(
      afterDirect.queued,
      beforeDirect.queued + 1,
      'direct original occupiedMove must emit exactly one action span',
    )
  }
  for (const index of [1, 3, 2, 6]) await cell(page, index).click()
  state = await snapshot(page)
  assert.equal(state.winner, 'X')
  assert.deepEqual(state.scores, [1, 0, 0])
  await page.getByRole('button', { name: '🔄 New Game' }).click()
  state = await snapshot(page)
  assert.deepEqual(state.board, Array(9).fill(null))
  assert.equal(state.player, 'X')
  assert.equal(state.winner, 'none')
  await controls(page, 'explicitReset')
  return state
}

const expectAiXo = async (page) => {
  await page.getByText('👥 2 Players', { exact: true }).click()
  await page.waitForFunction(
    () => window.collectorTest.snapshot().computer === true,
  )
  await cell(page, 0).click()
  await page.waitForFunction(() => {
    const state = window.collectorTest.snapshot()
    return !state.thinking && state.board.filter(Boolean).length === 2
  })
  const state = await snapshot(page)
  assert.equal(state.board[0], 'X')
  assert.equal(state.board[4], 'O')
  assert.equal(state.player, 'X')
  return state
}

const fillSearch = async (page, value) => {
  await page.getByPlaceholder('Search GitHub issues...').fill(value)
}

const expectSearchHappy = async (page, searchQueue) => {
  const entry = {
    started: deferred(),
    gate: deferred(),
    body: issues('alpha page 1'),
  }
  searchQueue.push(entry)
  await fillSearch(page, 'alpha')
  const initialRequest = await entry.started.promise
  assert.equal(
    await controls(page, 'traceSearch'),
    true,
    'traceSearch must retain the original request Promise',
  )
  entry.gate.resolve()
  await page.getByText('alpha page 1', { exact: true }).waitFor()
  const sorted = {
    started: deferred(),
    gate: deferred(),
    body: issues('alpha sorted by created'),
  }
  searchQueue.push(sorted)
  await page.getByPlaceholder('Sort by', { exact: true }).click()
  await page.getByRole('option', { name: 'Created date' }).click()
  const sortRequest = new URL((await sorted.started.promise).url())
  const initialUrl = new URL(initialRequest.url())
  assert.equal(sortRequest.searchParams.get('sort'), 'created')
  assert.equal(
    sortRequest.searchParams.get('q'),
    initialUrl.searchParams.get('q'),
  )
  assert.equal(
    sortRequest.searchParams.get('page'),
    initialUrl.searchParams.get('page'),
  )
  sorted.gate.resolve()
  await page.getByText('alpha sorted by created', { exact: true }).waitFor()
  assert.deepEqual((await snapshot(page)).titles, ['alpha sorted by created'])
  await page.getByRole('button', { name: '2' }).last().click()
  await page.getByText('alpha page 2', { exact: true }).waitFor()
  const state = await snapshot(page)
  assert.equal(state.query, 'alpha')
  assert.equal(state.page, 2)
  assert.deepEqual(state.titles, ['alpha page 2'])
  return state
}

const expectSearchRecovery = async (page, searchQueue) => {
  const a = { started: deferred(), gate: deferred(), body: issues('A stale') }
  const b = { started: deferred(), gate: deferred(), body: issues('B current') }
  searchQueue.push(a, b)
  await fillSearch(page, 'A')
  await a.started.promise
  await fillSearch(page, 'B')
  await b.started.promise
  b.gate.resolve()
  await page.getByText('B current', { exact: true }).waitFor()
  a.gate.resolve()
  await page.waitForFunction(() =>
    window.collectorTest.snapshot().titles.includes('B current'),
  )
  let state = await snapshot(page)
  assert.deepEqual(state.titles, ['B current'])
  const failure = {
    started: deferred(),
    gate: deferred(),
    status: 503,
    body: { message: 'PUBLIC_FIXTURE PRIVATE_FIXTURE' },
  }
  searchQueue.push(failure)
  await fillSearch(page, 'error')
  await failure.started.promise
  assert.equal(await controls(page, 'traceSearch', 'search.failure'), true)
  failure.gate.resolve()
  await page.getByText('PUBLIC_FIXTURE PRIVATE_FIXTURE').waitFor()
  assert.match((await snapshot(page)).error, /PUBLIC_FIXTURE PRIVATE_FIXTURE/)
  searchQueue.push({ body: issues('recovery success') })
  await fillSearch(page, 'recovery')
  await page.getByText('recovery success', { exact: true }).waitFor()
  state = await snapshot(page)
  assert.equal(state.error, null)
  assert.deepEqual(state.titles, ['recovery success'])
  return state
}

const flows = {
  'E01-tree7': async ({ page }) => expectTree(page),
  'E02-xo-human': async ({ page }) => expectHumanXo(page),
  'E03-xo-ai': async ({ page }) => expectAiXo(page),
  'E04-search': async ({ page, searchQueue }) =>
    expectSearchHappy(page, searchQueue),
  'E05-search-recovery': async ({ page, searchQueue }) =>
    expectSearchRecovery(page, searchQueue),
}

const specs = [
  ['E01-tree7', 'tree', { treeExecution: true }],
  [
    'E02-xo-human',
    'xo',
    {
      requiredNames: ['makeMove', 'resetGame', 'explicit.root'],
      expectedCount: 9,
      relationships: [{ child: 'explicit.root', parent: null }],
      spanExpectations: [{ name: 'explicit.root', kind: 1, statusCode: 0 }],
      actionRelationships: [
        {
          parent: 'explicit.root',
          child: 'resetGame',
          parentCount: 1,
          childCount: 2,
          matchingCount: 1,
        },
      ],
      noWriteSpans: true,
    },
  ],
  [
    'E03-xo-ai',
    'xo',
    {
      requiredNames: ['makeMove', 'computerMove'],
      expectedCount: 4,
      spanExpectations: [
        {
          name: 'computerMove',
          kind: 1,
          statusCode: 0,
          minDurationNs: '400000000',
        },
      ],
      actionRelationships: [
        {
          parent: 'makeMove',
          child: 'computerMove',
          parentCount: 2,
          childCount: 1,
          matchingCount: 1,
          rootCount: 2,
        },
      ],
    },
  ],
  [
    'E04-search',
    'search',
    {
      requiredNames: ['search.request'],
      expectedCount: 1,
      spanExpectations: [{ name: 'search.request', kind: 1, statusCode: 0 }],
    },
  ],
  [
    'E05-search-recovery',
    'search',
    {
      requiredNames: ['search.failure'],
      expectedCount: 1,
      spanExpectations: [
        {
          name: 'search.failure',
          kind: 1,
          statusCode: 2,
          eventNames: ['exception'],
        },
      ],
      defaultPrivacy: ['PUBLIC_FIXTURE', 'PRIVATE_FIXTURE'],
    },
  ],
]

const runOne = async ({
  browser,
  origin,
  runId,
  artifactDirectory,
  caseId,
  app,
  expectation,
  mode,
  query = '',
}) => {
  const resourceCaseId = `${caseId}-${mode}`
  const errors = []
  const searchQueue = []
  const { context, page, wireBodies, waitForWire } = await createPage(
    browser,
    errors,
    searchQueue,
  )
  let ui
  let stats
  const deliveryExpected = mode === 'traced'
  try {
    await page.goto(appUrl(origin, app, mode, resourceCaseId, runId, query), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.collectorTest?.ready === true)
    ui = await flows[caseId]({ page, searchQueue })
    // Playwright routing auto-fulfills preflight, including unmatched URLs.
    // App fixtures are finished; disable interception before native OTLP.
    await page.unrouteAll({ behavior: 'wait' })
    stats = await controls(page, 'flush')
    await waitForWire()
    if (mode === 'raw') {
      assert.equal(wireBodies.length, 0, 'raw mode must make no OTLP request')
    } else {
      assertStats(stats, { deliveryExpected })
      assert(
        wireBodies.length > 0,
        'traced positive case must issue OTLP request',
      )
    }
    assert.deepEqual(
      errors,
      [],
      `unexpected browser diagnostics: ${errors.join('\n')}`,
    )
  } catch (error) {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  } finally {
    await controls(page, 'dispose').catch(() => {})
    await context.close()
  }
  const record = {
    caseId: resourceCaseId,
    scenarioId: caseId,
    app,
    mode,
    wireBodies,
    ui,
    expectation,
    errors,
    deliveryExpected,
    stats,
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    join(artifactDirectory, `${caseId}-${mode}.json`),
    JSON.stringify(record, null, 2) + '\n',
  )
  if (errors.length)
    throw new Error(`${caseId}/${mode} failed: ${errors.join('\n')}`)
  return record
}

const runOffline = async ({ browser, origin, runId, artifactDirectory }) => {
  const caseId = 'E06-offline'
  const errors = []
  const { context, page, wireBodies, waitForWire } = await createPage(
    browser,
    errors,
    [],
  )
  let ui
  let stats
  try {
    await page.goto(
      appUrl(origin, 'xo', 'traced', caseId, runId, '&offline=true'),
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => window.collectorTest?.ready === true)
    await cell(page, 0).click()
    ui = await snapshot(page)
    assert.equal(ui.board[0], 'X')
    assert.equal(ui.player, 'O')
    // Playwright routing auto-fulfills preflight, including unmatched URLs.
    // App fixtures are finished; disable interception before native OTLP.
    await page.unrouteAll({ behavior: 'wait' })
    stats = await controls(page, 'flush')
    await waitForWire()
    assertStats(stats, { deliveryExpected: false })
  } catch (error) {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  } finally {
    await controls(page, 'dispose').catch(() => {})
    await context.close()
  }
  const diagnostics = [...errors]
  const unexpected = errors.filter(
    (error) => !isExpectedDeliveryDiagnostic(error),
  )
  const record = {
    caseId,
    app: 'xo',
    mode: 'traced',
    wireBodies,
    ui,
    expectation: { requiredNames: ['makeMove'], noCollectorSpans: true },
    errors: unexpected,
    diagnostics,
    deliveryExpected: false,
    stats,
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    join(artifactDirectory, `${caseId}-traced.json`),
    JSON.stringify(record, null, 2) + '\n',
  )
  if (unexpected.length)
    throw new Error(`${caseId}/traced failed: ${unexpected.join('\n')}`)
  return record
}

const runPrivacyOptIn = async ({
  browser,
  origin,
  runId,
  artifactDirectory,
}) => {
  const caseId = 'E05-search-capture'
  const errors = []
  const failure = {
    started: deferred(),
    gate: deferred(),
    status: 503,
    body: { message: 'PUBLIC_FIXTURE PRIVATE_FIXTURE' },
  }
  const { context, page, wireBodies, waitForWire } = await createPage(
    browser,
    errors,
    [failure],
  )
  let stats
  try {
    await page.goto(
      appUrl(origin, 'search', 'traced', caseId, runId, '&capture=true'),
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => window.collectorTest?.ready === true)
    await fillSearch(page, 'error')
    await failure.started.promise
    assert.equal(await controls(page, 'traceSearch', 'search.failure'), true)
    failure.gate.resolve()
    await page
      .getByText('Error: PUBLIC_FIXTURE PRIVATE_FIXTURE', { exact: true })
      .waitFor()
    assert.equal((await snapshot(page)).error, 'PUBLIC_FIXTURE PRIVATE_FIXTURE')
    // Playwright routing auto-fulfills preflight, including unmatched URLs.
    // App fixtures are finished; disable interception before native OTLP.
    await page.unrouteAll({ behavior: 'wait' })
    stats = await controls(page, 'flush')
    await waitForWire()
    assertStats(stats, { deliveryExpected: true })
    assert(
      wireBodies.some((body) => body.includes('PUBLIC_FIXTURE')),
      'opt-in public error sentinel missing',
    )
    assert(
      !wireBodies.some((body) => body.includes('PRIVATE_FIXTURE')),
      'redactor leaked private error sentinel',
    )
    assert.deepEqual(
      errors,
      [],
      `unexpected browser diagnostics: ${errors.join('\n')}`,
    )
  } catch (error) {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  } finally {
    await controls(page, 'dispose').catch(() => {})
    await context.close()
  }
  const record = {
    caseId,
    app: 'search',
    mode: 'traced',
    wireBodies,
    ui: { error: 'PUBLIC_FIXTURE PRIVATE_FIXTURE' },
    expectation: {
      requiredNames: ['search.failure'],
      expectedCount: 1,
      spanExpectations: [
        {
          name: 'search.failure',
          kind: 1,
          statusCode: 2,
          eventNames: ['exception'],
        },
      ],
      optInPrivacy: { public: 'PUBLIC_FIXTURE', private: 'PRIVATE_FIXTURE' },
    },
    errors,
    deliveryExpected: true,
    stats,
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    join(artifactDirectory, `${caseId}-traced.json`),
    JSON.stringify(record, null, 2) + '\n',
  )
  if (errors.length)
    throw new Error(`${caseId}/traced failed: ${errors.join('\n')}`)
  return record
}

const runDeniedCors = async ({ browser, origin, runId, artifactDirectory }) => {
  const caseId = 'E06-cors-denied'
  const deniedOrigin = origin.replace(/:4173$/, ':4174')
  const errors = []
  const { context, page, wireBodies, waitForWire } = await createPage(
    browser,
    errors,
    [],
  )
  let ui
  let stats
  try {
    await page.goto(appUrl(deniedOrigin, 'xo', 'traced', caseId, runId), {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => window.collectorTest?.ready === true)
    await cell(page, 0).click()
    ui = await snapshot(page)
    assert.equal(ui.board[0], 'X')
    assert.equal(ui.player, 'O')
    // Playwright routing auto-fulfills preflight, including unmatched URLs.
    // App fixtures are finished; disable interception before native OTLP.
    await page.unrouteAll({ behavior: 'wait' })
    stats = await controls(page, 'flush')
    await waitForWire()
    assertStats(stats, { deliveryExpected: false })
    assert(
      errors.every((error) =>
        /collector|CORS|Failed to fetch|NetworkError/i.test(error),
      ),
      `unexpected browser diagnostics: ${errors.join('\n')}`,
    )
  } catch (error) {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  } finally {
    await controls(page, 'dispose').catch(() => {})
    await context.close()
  }
  const diagnostics = [...errors]
  const unexpected = errors.filter(
    (error) => !isExpectedDeliveryDiagnostic(error),
  )
  const record = {
    caseId,
    app: 'xo',
    mode: 'traced',
    wireBodies,
    ui,
    expectation: { requiredNames: ['makeMove'], noCollectorSpans: true },
    errors: unexpected,
    diagnostics,
    deliveryExpected: false,
    stats,
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    join(artifactDirectory, `${caseId}-traced.json`),
    JSON.stringify(record, null, 2) + '\n',
  )
  if (unexpected.length)
    throw new Error(`${caseId}/traced failed: ${unexpected.join('\n')}`)
  return record
}

const runUnload = async ({
  browser,
  origin,
  runId,
  artifactDirectory,
  beacon,
  waitForDelivery,
  waitForCaseDelivery,
}) => {
  const caseId = beacon ? 'E06-unload-beacon' : 'E06-unload-keepalive'
  const errors = []
  const { context, page, wireBodies, wireRequests, waitForWire } =
    await createPage(browser, errors, [], !beacon)
  let ui
  let beforeUnload
  try {
    await page.goto(
      appUrl(
        origin,
        'xo',
        'traced',
        caseId,
        runId,
        beacon ? '&beacon=true' : '',
      ),
      { waitUntil: 'domcontentloaded' },
    )
    await page.waitForFunction(() => window.collectorTest?.ready === true)
    await cell(page, 0).click()
    ui = await snapshot(page)
    assert.equal(ui.board[0], 'X')
    beforeUnload = await controls(page, 'stats')
    assert(
      beforeUnload.queued > 0,
      'unload case must retain a queued record before real navigation',
    )
    await page.unrouteAll({ behavior: 'wait' })
    const requested = page.waitForRequest(
      (request) =>
        collectorUrl.test(request.url()) && request.method() === 'POST',
    )
    await Promise.all([
      requested,
      page.goto(`${origin}/blank`, { waitUntil: 'domcontentloaded' }),
    ])
    await waitForWire()
    assert.equal(wireRequests.length, 1, 'navigation must send one request')
    // Navigation destroys the old execution context; wait for its actual
    // Collector records before closing the whole BrowserContext/connection.
    // Chromium drops Blob request bodies from CDP during navigation. NetLog
    // supplies the independent outgoing bytes after browser.close(). This
    // receipt wait only keeps the connection alive; it is not the ID oracle.
    if (beacon) await waitForCaseDelivery(caseId, 1)
    else await waitForDelivery(wireBodies)
    assert.deepEqual(
      errors,
      [],
      `unexpected browser diagnostics: ${errors.join('\n')}`,
    )
  } catch (error) {
    errors.push(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    )
  } finally {
    await context.close()
  }
  const record = {
    caseId,
    app: 'xo',
    mode: 'traced',
    wireBodies,
    wireCapture: beacon ? 'netlog' : 'cdp',
    wireRequests,
    ui,
    expectation: {
      requiredNames: ['makeMove'],
      unload: beacon ? 'beacon' : 'keepalive',
      expectedCount: 1,
      spanExpectations: [{ name: 'makeMove', kind: 1, statusCode: 0 }],
    },
    errors,
    deliveryExpected: true,
    stats: beforeUnload,
  }
  await mkdir(artifactDirectory, { recursive: true })
  await writeFile(
    join(artifactDirectory, `${caseId}-traced.json`),
    JSON.stringify(record, null, 2) + '\n',
  )
  if (errors.length)
    throw new Error(`${caseId}/traced failed: ${errors.join('\n')}`)
  return record
}

export const runScenarios = async ({
  browser,
  origin = 'http://runner:4173',
  runId,
  artifactDirectory,
  caseFilter,
  waitForDelivery,
  waitForCaseDelivery,
}) => {
  assert(
    browser && typeof browser.newContext === 'function',
    'browser must be a Playwright Browser',
  )
  assert.equal(typeof runId, 'string', 'runId must be a string')
  assert.equal(
    typeof artifactDirectory,
    'string',
    'artifactDirectory must be a string',
  )
  const selected = specs.filter(
    ([caseId]) => !caseFilter || caseFilter.includes(caseId),
  )
  const cases = []
  for (const [caseId, app, expectation] of selected) {
    assert(APPS.has(app), `unknown app: ${app}`)
    const raw = await runOne({
      browser,
      origin,
      runId,
      artifactDirectory,
      caseId,
      app,
      expectation,
      mode: 'raw',
    })
    const traced = await runOne({
      browser,
      origin,
      runId,
      artifactDirectory,
      caseId,
      app,
      expectation,
      mode: 'traced',
    })
    assert.deepEqual(traced.ui, raw.ui, `${caseId}: raw/traced UI mismatch`)
    cases.push(raw, traced)
  }
  if (!caseFilter || caseFilter.includes('E05-search-capture'))
    cases.push(
      await runPrivacyOptIn({ browser, origin, runId, artifactDirectory }),
    )
  if (!caseFilter || caseFilter.includes('E06-offline'))
    cases.push(await runOffline({ browser, origin, runId, artifactDirectory }))
  if (!caseFilter || caseFilter.includes('E06-cors-denied'))
    cases.push(
      await runDeniedCors({ browser, origin, runId, artifactDirectory }),
    )
  if (!caseFilter || caseFilter.includes('E06-unload-keepalive'))
    cases.push(
      await runUnload({
        browser,
        origin,
        runId,
        artifactDirectory,
        beacon: false,
        waitForDelivery,
      }),
    )
  if (!caseFilter || caseFilter.includes('E06-unload-beacon'))
    cases.push(
      await runUnload({
        browser,
        origin,
        runId,
        artifactDirectory,
        beacon: true,
        waitForDelivery,
        waitForCaseDelivery,
      }),
    )
  return cases
}

const verifyTreeExecution = (spans, scenario) => {
  const tree = scenario.ui?.built
  const trace = scenario.ui?.trace
  assert(tree && trace, `${scenario.caseId}: missing pre-trace tree evidence`)
  // Original startup builds 16 nodes (15 adds), then the UI builds seven
  // (6 adds), toggles seven plus one leaf, and adds/deletes one branch.
  assert.equal(spans.length, 31, 'tree execution count')
  assert.equal(spans.filter((span) => span.name.endsWith('.add')).length, 22)
  assert.equal(spans.filter((span) => span.name.endsWith('.toggle')).length, 8)
  assert.equal(spans.filter((span) => span.name.endsWith('.del')).length, 1)
  const actionName = (id, action) => `tree#${id}.${action}`
  const actions = (id, action) =>
    spans.filter((span) => span.name === actionName(id, action))
  const rootActions = actions(tree.id, 'toggle')
  assert.equal(
    rootActions.length,
    1,
    `${scenario.caseId}: root toggle must execute exactly once`,
  )
  const root = rootActions[0]
  assert(
    !root.parentSpanId,
    `${scenario.caseId}: UI root toggle must be a root`,
  )

  const recursiveSpanIds = new Set([root.spanId])
  const visit = (parentId, parentSpan) => {
    for (const edge of trace.recursiveEdges.filter(
      (candidate) => candidate.parent === parentId,
    )) {
      const matches = actions(edge.child, 'toggle').filter(
        (child) =>
          child.traceId === parentSpan.traceId &&
          child.parentSpanId === parentSpan.spanId,
      )
      assert.equal(
        matches.length,
        1,
        `${scenario.caseId}: missing direct ${edge.parent} -> ${edge.child} toggle`,
      )
      assert(
        !recursiveSpanIds.has(matches[0].spanId),
        `${scenario.caseId}: recursive toggle reused a span`,
      )
      recursiveSpanIds.add(matches[0].spanId)
      visit(edge.child, matches[0])
    }
  }
  visit(tree.id, root)
  assert.equal(
    recursiveSpanIds.size,
    7,
    `${scenario.caseId}: root toggle must cover all seven original nodes`,
  )

  const leafActions = actions(trace.leafId, 'toggle')
  assert.equal(
    leafActions.length,
    2,
    `${scenario.caseId}: selected leaf must run once recursively and once directly`,
  )
  assert.equal(
    leafActions.filter((span) => !span.parentSpanId).length,
    1,
    `${scenario.caseId}: selected leaf toggle must be a fresh UI root`,
  )
  for (const [id, action, count] of [
    [tree.id, 'add', 3],
    [trace.addedId, 'del', 1],
  ]) {
    const actionSpans = actions(id, action)
    assert.equal(
      actionSpans.length,
      count,
      `${scenario.caseId}: unexpected ${id}.${action} execution count`,
    )
    assert(
      actionSpans.every((span) => !span.parentSpanId),
      `${scenario.caseId}: ${id}.${action} must be a fresh UI root`,
    )
  }
}

export const verifyScenarios = (decodedSpans, cases) => {
  assert(Array.isArray(decodedSpans), 'decodedSpans must be an array')
  for (const scenario of cases) {
    if (!scenario.deliveryExpected) continue
    const spans = decodedSpans.filter(
      (span) => span.resource?.['test.case_id'] === scenario.caseId,
    )
    assert(spans.length > 0, `${scenario.caseId}: Collector lacks traced spans`)
    const names = spans.map((span) => span.name)
    if (scenario.expectation.treeExecution) verifyTreeExecution(spans, scenario)
    for (const relationship of scenario.expectation.actionRelationships ?? []) {
      const parents = spans.filter((span) => span.name === relationship.parent)
      const children = spans.filter((span) => span.name === relationship.child)
      assert.equal(
        parents.length,
        relationship.parentCount,
        `${scenario.caseId}: unexpected ${relationship.parent} count`,
      )
      assert.equal(
        children.length,
        relationship.childCount,
        `${scenario.caseId}: unexpected ${relationship.child} count`,
      )
      const matching = children.filter((child) =>
        parents.some(
          (parent) =>
            child.traceId === parent.traceId &&
            child.parentSpanId === parent.spanId,
        ),
      )
      assert.equal(
        matching.length,
        relationship.matchingCount,
        `${scenario.caseId}: wrong ${relationship.parent} -> ${relationship.child} parent`,
      )
      if (relationship.rootCount !== undefined)
        assert.equal(
          parents.filter((span) => !span.parentSpanId).length,
          relationship.rootCount,
          `${scenario.caseId}: ${relationship.parent} must include the post-await root`,
        )
    }
    if (scenario.expectation.noWriteSpans)
      assert(
        !names.some((name) =>
          ['board', 'currentPlayer', 'winner', 'scores'].includes(name),
        ),
        `${scenario.caseId}: unexpected write span`,
      )
    for (const sentinel of scenario.expectation.defaultPrivacy ?? [])
      assert(
        !JSON.stringify(spans).includes(sentinel),
        `${scenario.caseId}: privacy sentinel leaked`,
      )
    if (scenario.expectation.optInPrivacy) {
      const serialized = JSON.stringify(spans)
      assert(
        serialized.includes(scenario.expectation.optInPrivacy.public),
        `${scenario.caseId}: opted-in public value missing`,
      )
      assert(
        !serialized.includes(scenario.expectation.optInPrivacy.private),
        `${scenario.caseId}: opted-in private value leaked`,
      )
    }
  }
}
