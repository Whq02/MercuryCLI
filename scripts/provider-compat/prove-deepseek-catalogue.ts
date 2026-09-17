#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'deepseek-catalogue-proof-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DEEPSEEK_API_BASE = 'https://deepseek.fixture.invalid'
for (const key of [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[key]
}

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const pins = await import('../../src/services/providers/deepseek/deepseekPins.ts')
const { DEEPSEEK_DISPLAY_PINS, deepseekDisplayPin, deepseekDisplayName } = pins
const catalogue = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts').catch(() => null)
const router = await import('../../src/utils/router/providers/deepseek.ts')
const { DEEPSEEK_STATIC_CATALOGUE, describeDeepseekProvider, listDeepseekModels } = router
const { keyLanePins, getModelOptions, DEEPSEEK_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { parseUserSpecifiedModel } = await import('../../src/utils/model/model.ts')
const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
const { resolveContextWindow } = await import('../../src/utils/model/capabilities.ts')
const { providerFrontierFact, providerFrontierLine } = await import('../../src/utils/model/providerFrontier.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { writeStoredDeepseekApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const { deepseekLaneProfile } = await import('../../src/services/providers/deepseek/deepseekCallModel.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { catalogueTrafficVerdict } = await import('../../src/services/providers/catalogueGate.ts')

const CURRENT_FLASH = 'deepseek-flash'
const RETIRED_FLASH = 'deepseek-v4-flash'
const flashPin = DEEPSEEK_DISPLAY_PINS.find(p => p.displayName === 'DeepSeek V4.1 Flash')
const proPin = DEEPSEEK_DISPLAY_PINS.find(p => p.id === 'deepseek-v4-pro')
const PIN_DATE = proPin?.observedAt ?? ''

const DOC_PAGE = {
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
  ],
}
const FIXTURE_PAGE = {
  object: 'list',
  data: [
    { id: 'deepseek-flash', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-fixture-next', object: 'model', owned_by: 'deepseek' },
  ],
}
const pageFetch = (page: unknown, calls?: { n: number; urls: string[]; headers: Record<string, string>[] }) =>
  (async (url: unknown, init?: RequestInit) => {
    if (calls) {
      calls.n++
      calls.urls.push(String(url))
      calls.headers.push({ ...((init?.headers as Record<string, string> | undefined) ?? {}) })
    }
    return String(url).endsWith('/models') ? jsonResponse(200, page) : jsonResponse(404, {})
  }) as typeof fetch
const statusFetch = (status: number) => (async () => jsonResponse(status, { error: { message: `fixture ${status}` } })) as typeof fetch

section('1 · the pins and the retired alias (no network)')
{
  check('the Flash pin carries the page\'s own id (deepseek-flash) with its label', flashPin?.id === CURRENT_FLASH, String(flashPin?.id))
  check('no pin carries the retired id', DEEPSEEK_DISPLAY_PINS.every(p => p.id !== RETIRED_FLASH))
  check('the retired id folds onto the current id', pins.deepseekCurrentModelId?.(RETIRED_FLASH) === CURRENT_FLASH, String(pins.deepseekCurrentModelId?.(RETIRED_FLASH)))
  check('the fold is case- and whitespace-insensitive', pins.deepseekCurrentModelId?.(' DeepSeek-V4-Flash ') === CURRENT_FLASH)
  check('a current id passes through unchanged', pins.deepseekCurrentModelId?.('deepseek-v4-pro') === 'deepseek-v4-pro' && pins.deepseekCurrentModelId?.(CURRENT_FLASH) === CURRENT_FLASH)
  check('the vision-exp legacy name is not folded (out of scope, unpinned)', pins.deepseekCurrentModelId?.('deepseek-v4-flash-vision-exp') === 'deepseek-v4-flash-vision-exp' && deepseekDisplayPin('deepseek-v4-flash-vision-exp') === undefined)
  check('the pin lookup folds the alias: the retired id reads the Flash pin', deepseekDisplayPin(RETIRED_FLASH)?.id === CURRENT_FLASH && deepseekDisplayPin(RETIRED_FLASH)?.displayName === 'DeepSeek V4.1 Flash')
  check('the display name folds the alias', deepseekDisplayName(RETIRED_FLASH) === 'DeepSeek V4.1 Flash')
  check('the saved-setting parser resolves the retired id to the current one', parseUserSpecifiedModel(RETIRED_FLASH) === CURRENT_FLASH, parseUserSpecifiedModel(RETIRED_FLASH))
  check('…and leaves the current ids alone', parseUserSpecifiedModel(CURRENT_FLASH) === CURRENT_FLASH && parseUserSpecifiedModel('deepseek-v4-pro') === 'deepseek-v4-pro')
  check('the routing law classes the current id on the DeepSeek lane', declaredRouteOf(CURRENT_FLASH) === 'deepseek' && declaredRouteOf(RETIRED_FLASH) === 'deepseek')
  const retiredPricing = resolveModelPricing(RETIRED_FLASH)
  const currentPricing = resolveModelPricing(CURRENT_FLASH)
  check('the ledger prices the retired id at the Flash pin (recorded)', retiredPricing.basis === 'recorded' && retiredPricing.costs.inputTokens === flashPin?.costInPerMtok && retiredPricing.costs.outputTokens === flashPin?.costOutPerMtok, JSON.stringify(retiredPricing))
  check('…the same rates as the current id', currentPricing.basis === 'recorded' && currentPricing.costs.inputTokens === retiredPricing.costs.inputTokens)
  const retiredWindow = resolveContextWindow(RETIRED_FLASH)
  check('the context window of the retired id is the Flash pin\'s (static-pin)', retiredWindow.effectiveWindow === flashPin?.contextWindow && retiredWindow.source === 'static-pin', JSON.stringify({ w: retiredWindow.effectiveWindow, s: retiredWindow.source }))
  check('the wire id sent for the retired id is the current id', deepseekLaneProfile.wireModelId(RETIRED_FLASH) === CURRENT_FLASH && deepseekLaneProfile.wireModelId('deepseek-v4-pro') === 'deepseek-v4-pro', deepseekLaneProfile.wireModelId(RETIRED_FLASH))
  check('the static router catalogue lists the current ids only', DEEPSEEK_STATIC_CATALOGUE.map(e => e.id).join(',') === `deepseek-v4-pro,${CURRENT_FLASH}`, DEEPSEEK_STATIC_CATALOGUE.map(e => e.id).join(','))
  check('the router\'s entry lookup folds the alias', router.deepseekCatalogueEntry?.(RETIRED_FLASH)?.id === CURRENT_FLASH && router.deepseekCatalogueEntry?.('deepseek-nobody') === undefined)
  check('the catalogue door knows the DeepSeek family (no key ⇒ no request)', catalogueTrafficVerdict('deepseek' as never).allowed === false && (catalogueTrafficVerdict('deepseek' as never) as { reason?: string }).reason?.includes('connect DeepSeek to browse its models') === true, JSON.stringify(catalogueTrafficVerdict('deepseek' as never)))
}

section('2 · decode and the fetch (the documented page shape, injected fetch)')
if (!catalogue) {
  check('the catalogue module exists', false, 'src/services/providers/deepseek/deepseekCatalogue.ts is absent')
} else {
  const rows = DOC_PAGE.data.map(catalogue.decodeDeepseekModel)
  check('the documented page decodes to ids with their owner', rows.length === 2 && rows[0]?.id === 'deepseek-flash' && rows[0]?.ownedBy === 'deepseek' && rows[1]?.id === 'deepseek-v4-pro')
  check('a row without an id is skipped; an unstated owner stays absent', catalogue.decodeDeepseekModel({ object: 'model' }) === undefined && catalogue.decodeDeepseekModel({ id: 'deepseek-x' })?.ownedBy === undefined)
  const calls = { n: 0, urls: [] as string[], headers: [] as Record<string, string>[] }
  const landed = await catalogue.fetchDeepseekLiveModels({ baseUrl: 'https://deepseek.fixture.invalid', key: 'sk-fixture', fetchImpl: pageFetch(DOC_PAGE, calls) })
  check('one GET {base}/models with the bearer key', calls.n === 1 && calls.urls[0] === 'https://deepseek.fixture.invalid/models' && calls.headers[0]?.authorization === 'Bearer sk-fixture', JSON.stringify(calls))
  check('the page lands as two models with a fetch stamp', landed.models.length === 2 && landed.fetchedAtMs > 0)
  const refused = await catalogue.fetchDeepseekLiveModels({ baseUrl: 'https://deepseek.fixture.invalid', key: 'sk-fixture', fetchImpl: statusFetch(401) }).then(() => '', (e: Error) => e.message)
  check('a 401 names a refused credential', refused.includes('refused the credential (HTTP 401)'), refused)
  const down = await catalogue.fetchDeepseekLiveModels({ baseUrl: 'https://deepseek.fixture.invalid', key: 'sk-fixture', fetchImpl: statusFetch(503) }).then(() => '', (e: Error) => e.message)
  check('a 503 names the status', down.includes('returned HTTP 503'), down)
  const foreign = await catalogue.fetchDeepseekLiveModels({ baseUrl: 'https://deepseek.fixture.invalid', key: 'sk-fixture', fetchImpl: pageFetch({ object: 'list', data: [{ id: 'gpt-4', object: 'model' }] }) }).then(() => '', (e: Error) => e.message)
  check('a page whose ids do not ride the DeepSeek lane is refused as a non-catalogue view', foreign.includes('non-catalogue view'), foreign)
}

section('3 · the door and the cache')
if (catalogue) {
  catalogue.__resetDeepseekCatalogueForTest()
  const doorCalls = { n: 0, urls: [] as string[], headers: [] as Record<string, string>[] }
  const closed = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls) })
  check('no key: the door refuses — zero requests, nothing cached', closed === null && doorCalls.n === 0 && catalogue.getCachedDeepseekCatalogue() === null)
  check('no key: the kick starts nothing', catalogue.kickDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls) }) === false && doorCalls.n === 0)
  writeStoredDeepseekApiKey('sk-deepseek-proof-stored-000001')
  let t = 1_000_000
  const now = () => t
  const e0 = catalogueEpoch()
  const snapshot = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls), now })
  check('the stored key opens the door: one request, three rows keyed to the stored source', doorCalls.n === 1 && snapshot?.keySource === 'stored' && snapshot?.models.length === 3 && snapshot.fetchedAtMs === t, JSON.stringify(snapshot))
  check('the settle bumped the catalogue epoch once', catalogueEpoch() === e0 + 1)
  t += 1_000
  await catalogue.refreshDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls), now })
  check('inside the TTL a refresh makes no request', doorCalls.n === 1)
  t += 5 * 60_000
  await catalogue.refreshDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls), now })
  check('past the TTL it fetches again', doorCalls.n === 2)
  const e1 = catalogueEpoch()
  const failed = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: statusFetch(503), now })
  check('a failed refresh keeps the rows, labels the error and bumps the epoch', failed?.models.length === 3 && (failed?.lastError ?? '').includes('HTTP 503') && catalogueEpoch() === e1 + 1, JSON.stringify(failed))
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const dark = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls), now })
  check('traffic off: no request, the cached snapshot keeps serving', doorCalls.n === 2 && dark?.models.length === 3)
  check('traffic off: the kick starts nothing', catalogue.kickDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls) }) === false && doorCalls.n === 2)
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
  writeStoredDeepseekApiKey('sk-deepseek-proof-stored-000002')
  check('a different key is a different catalogue: nothing cached for it', catalogue.getCachedDeepseekCatalogue() === null)
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-proof-env-000001'
  const viaEnv = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(FIXTURE_PAGE, doorCalls), now })
  check('the env key wins and labels the source env', viaEnv?.keySource === 'env' && doorCalls.n === 3)
  delete process.env.DEEPSEEK_API_KEY
  catalogue.__resetDeepseekCatalogueForTest()
  const kickCalls = { n: 0, urls: [] as string[], headers: [] as Record<string, string>[] }
  const kicked = catalogue.kickDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, kickCalls) })
  await new Promise(r => setTimeout(r, 20))
  check('with a key and nothing cached the kick starts one refresh', kicked === true && kickCalls.n === 1 && catalogue.getCachedDeepseekCatalogue()?.models.length === 3)
  check('with rows cached the kick starts nothing', catalogue.kickDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, kickCalls) }) === false && kickCalls.n === 1)
  catalogue.__resetDeepseekCatalogueForTest()
  t = 2_000_000
  await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: statusFetch(503), now })
  const retryCalls = { n: 0, urls: [] as string[], headers: [] as Record<string, string>[] }
  t += 5_000
  await catalogue.refreshDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, retryCalls), now })
  check('after a failure with no rows, a refresh inside the retry window asks nothing', retryCalls.n === 0)
  t += 6_000
  await catalogue.refreshDeepseekCatalogue({ fetchImpl: pageFetch(FIXTURE_PAGE, retryCalls), now })
  check('past the retry window it asks again and lands', retryCalls.n === 1 && catalogue.getCachedDeepseekCatalogue()?.models.length === 3)
}

section('4 · the derivations over a live list: the router arm, the picker rows, the frontier line')
if (catalogue) {
  catalogue.__resetDeepseekCatalogueForTest()
  const landed = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(FIXTURE_PAGE) })
  const derived = catalogue.deepseekCatalogueRows()
  check('the source is the live list with its count and stamp', derived.source.kind === 'live' && derived.source.count === 3 && derived.source.fetchedAtMs === landed?.fetchedAtMs, JSON.stringify(derived.source))
  check('the rows: the pinned ids first in the pins\' order, then the unpinned live id', derived.rows.map(r => r.id).join(',') === `deepseek-v4-pro,${CURRENT_FLASH},deepseek-fixture-next`, derived.rows.map(r => r.id).join(','))
  const next = derived.rows.find(r => r.id === 'deepseek-fixture-next')
  check('the unpinned row carries the mechanical name, no window, and the live flag', next?.displayName === 'Deepseek Fixture Next' && next?.contextWindow === undefined && next?.listedLive === true, JSON.stringify(next))
  const pro = derived.rows.find(r => r.id === 'deepseek-v4-pro')
  check('a pinned row keeps the pin\'s label, window and date', pro?.displayName === 'DeepSeek V4 Pro' && pro?.contextWindow === proPin?.contextWindow && pro?.observedAt === PIN_DATE && pro?.listedLive === true, JSON.stringify(pro))
  const lanePins = keyLanePins('deepseek')
  check('keyLanePins reads the same rows', lanePins.map(p => p.id).join(',') === derived.rows.map(r => r.id).join(',') && lanePins.every(p => p.listedLive === true), JSON.stringify(lanePins))
  const described = describeDeepseekProvider()
  check('the router describes a live catalogue with its stamp', described.catalogueSource === 'live-discovery' && described.discoveredAtMs === landed?.fetchedAtMs && described.catalogue.map(e => e.id).join(',') === `deepseek-v4-pro,${CURRENT_FLASH},deepseek-fixture-next`, JSON.stringify({ s: described.catalogueSource, ids: described.catalogue.map(e => e.id) }))
  const nextEntry = described.catalogue.find(e => e.id === 'deepseek-fixture-next')
  check('an unpinned live entry states no window and the lane\'s effort words', nextEntry?.contextWindow === undefined && nextEntry?.efforts.join(',') === 'low,high,max' && nextEntry?.displayLabel === 'Deepseek Fixture Next')
  const listed = listDeepseekModels()
  check('the seat listing follows the live rows (the stored key present)', listed.map(m => m.ref.model).join(',') === `deepseek-v4-pro,${CURRENT_FLASH},deepseek-fixture-next` && listed[0]?.ref.contextWindow === proPin?.contextWindow && listed[2]?.ref.contextWindow === 0, JSON.stringify(listed.map(m => [m.ref.model, m.ref.contextWindow])))
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-proof-env-000001'
  check('a different credential never reads another key\'s snapshot: the env key sees the pins until its own list lands', catalogue.deepseekCatalogueRows().source.kind === 'pin' && listDeepseekModels().length === 2)
  delete process.env.DEEPSEEK_API_KEY
  check('the router entry lookup reads the live list first', router.deepseekCatalogueEntry?.('deepseek-fixture-next')?.displayLabel === 'Deepseek Fixture Next' && router.deepseekCatalogueEntry?.(RETIRED_FLASH)?.id === CURRENT_FLASH)
  const fact = providerFrontierFact('deepseek')
  check('the frontier fact is the first pinned row with the live words in place of the date', fact?.modelId === 'deepseek-v4-pro' && fact?.source === '3 models live' && fact?.observedAt === undefined, JSON.stringify(fact))
  check('the group line paints the live grammar', providerFrontierLine('deepseek') === 'frontier: DeepSeek V4 Pro · 3 models live', String(providerFrontierLine('deepseek')))
  const options = getModelOptions().filter(o => o.group === DEEPSEEK_MODEL_GROUP)
  check('the picker\'s DeepSeek rows are the live rows, in order', options.map(o => o.value).join(',') === `deepseek-v4-pro,${CURRENT_FLASH},deepseek-fixture-next`, options.map(o => o.value).join(','))
  check('a live row\'s description names the live list; the unpinned row states no window', (options[2]?.descriptionForModel ?? '').includes('live') && options[2]?.statedContextWindow === undefined && options[0]?.statedContextWindow === proPin?.contextWindow, options[2]?.descriptionForModel)
  catalogue.__resetDeepseekCatalogueForTest()
  await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch({ object: 'list', data: [{ id: 'deepseek-v4-pro', object: 'model', owned_by: 'deepseek' }] }) })
  const dropped = catalogue.deepseekCatalogueRows()
  check('a pin the live list no longer names is dropped from the rows', dropped.rows.map(r => r.id).join(',') === 'deepseek-v4-pro' && dropped.source.kind === 'live', dropped.rows.map(r => r.id).join(','))
  check('…while a saved retired id still resolves to the current id (the alias outlives the list)', parseUserSpecifiedModel(RETIRED_FLASH) === CURRENT_FLASH && deepseekDisplayPin(RETIRED_FLASH)?.id === CURRENT_FLASH)
  check('the group line counts the rows the list names', providerFrontierLine('deepseek') === 'frontier: DeepSeek V4 Pro · 1 model live', String(providerFrontierLine('deepseek')))
}

section('5 · the fallback: no list, the dated pins stand in')
if (catalogue) {
  catalogue.__resetDeepseekCatalogueForTest()
  const derived = catalogue.deepseekCatalogueRows()
  check('the source is the pin table with its date', derived.source.kind === 'pin' && derived.source.observedAt === PIN_DATE, JSON.stringify(derived.source))
  check('the rows are the pins, none flagged live', derived.rows.map(r => r.id).join(',') === `deepseek-v4-pro,${CURRENT_FLASH}` && derived.rows.every(r => r.listedLive === false))
  check('keyLanePins reads the pins', keyLanePins('deepseek').map(p => p.id).join(',') === `deepseek-v4-pro,${CURRENT_FLASH}`)
  const described = describeDeepseekProvider()
  check('the router describes the static pins with no stamp', described.catalogueSource === 'static-pin' && described.discoveredAtMs === undefined && described.catalogue.length === 2)
  const fact = providerFrontierFact('deepseek')
  check('the frontier fact carries the pin\'s date and no live words', fact?.modelId === 'deepseek-v4-pro' && fact?.observedAt === PIN_DATE && fact?.source === undefined, JSON.stringify(fact))
  check('the group line paints the date', providerFrontierLine('deepseek') === `frontier: DeepSeek V4 Pro · ${PIN_DATE}`, String(providerFrontierLine('deepseek')))
  const options = getModelOptions().filter(o => o.group === DEEPSEEK_MODEL_GROUP)
  check('the picker paints the pins with their windows', options.map(o => o.value).join(',') === `deepseek-v4-pro,${CURRENT_FLASH}` && options.every(o => o.statedContextWindow === 1_000_000), options.map(o => o.value).join(','))
  await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: statusFetch(503) })
  const failedRows = catalogue.deepseekCatalogueRows()
  check('a failed fetch with no rows leaves the pins standing in', failedRows.source.kind === 'pin' && failedRows.rows.length === 2)
  catalogue.__resetDeepseekCatalogueForTest()
}

section('6 · the shape: where the kick lives, and where it never does')
{
  const options = readFileSync(join(ROOT, 'src/utils/model/modelOptions.ts'), 'utf8')
  const between = (text: string, from: string, to: string): string => {
    const a = text.indexOf(from)
    const b = text.indexOf(to, a + from.length)
    return a < 0 ? '' : text.slice(a, b < 0 ? undefined : b)
  }
  const pinsBody = between(options, 'export function keyLanePins', '\nexport function')
  const compose = between(options, 'export function getModelOptions', '\nexport function')
  check('keyLanePins is a sync cache read: no kick, no refresh (the computed default rides it)', pinsBody.includes('deepseekCatalogueRows') && !pinsBody.includes('kickDeepseekCatalogue') && !pinsBody.includes('refreshDeepseekCatalogue'))
  check('the composition kicks the read before the key-lane rows', compose.includes('kickDeepseekCatalogue()') && compose.indexOf('kickDeepseekCatalogue()') < compose.indexOf('keyLaneProviderRows()'))
  const gate = readFileSync(join(ROOT, 'src/services/providers/catalogueGate.ts'), 'utf8')
  check('the catalogue door names the DeepSeek family and its credential owner', gate.includes("'deepseek'") && gate.includes('resolveDeepseekApiKey'))
  const dispatch = readFileSync(join(ROOT, 'src/utils/swarm/engineDispatch.ts'), 'utf8')
  check('sub-agent dispatch reads the DeepSeek class through the catalogue entries and an exact id through the folding entry lookup', /deepseekCatalogueEntries\(\)\[0\]/.test(dispatch) && /deepseekCatalogueEntry\(id\)/.test(dispatch) && !/DEEPSEEK_STATIC_CATALOGUE\.find\(/.test(dispatch))
}

console.log(failures === 0 ? '\n ✅ DEEPSEEK CATALOGUE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
