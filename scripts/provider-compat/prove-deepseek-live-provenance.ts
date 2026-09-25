#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'deepseek-live-provenance-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_DEEPSEEK_API_BASE = 'http://127.0.0.1:1'
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
const catalogue = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')
const router = await import('../../src/utils/router/providers/deepseek.ts')
const { keyLanePins, getModelOptions, DEEPSEEK_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { providerFrontierLine } = await import('../../src/utils/model/providerFrontier.ts')
const { writeStoredDeepseekApiKey } = await import('../../src/utils/router/providerSecrets.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')

type LiveIds = (env?: NodeJS.ProcessEnv) => ReadonlySet<string>
const liveIds = (catalogue as { cachedLiveIds?: LiveIds }).cachedLiveIds
const ids = (): string[] => (liveIds ? [...liveIds()].sort() : ['<cachedLiveIds absent>'])

const PRO = 'deepseek-v4-pro'
const OFF = 'v4-flash'
const LIST = {
  object: 'list',
  data: [
    { id: PRO, object: 'model', owned_by: 'deepseek' },
    { id: OFF, object: 'model', owned_by: 'deepseek' },
  ],
}
const NAMED_LIST = {
  object: 'list',
  data: [
    { id: PRO, object: 'model', owned_by: 'deepseek' },
    { id: OFF, object: 'model', owned_by: 'deepseek', display_name: 'V4 Flash (the endpoint names it)' },
  ],
}
const OFF_ONLY = { object: 'list', data: [{ id: OFF, object: 'model', owned_by: 'deepseek' }] }
const pageFetch = (page: unknown) =>
  (async (url: unknown) => (String(url).endsWith('/models') ? jsonResponse(200, page) : jsonResponse(404, {}))) as typeof fetch
const statusFetch = (status: number) => (async () => jsonResponse(status, { error: { message: `fixture ${status}` } })) as typeof fetch

section('1 · signed out: no account, no list, nothing routes by provenance')
{
  catalogue.__resetDeepseekCatalogueForTest()
  check('the catalogue exports cachedLiveIds', typeof liveIds === 'function')
  check('signed out, cachedLiveIds is empty', ids().length === 0, ids().join(','))
  const rows = catalogue.deepseekCatalogueRows()
  check('signed out, the rows are the dated pins', rows.source.kind === 'pin' && rows.rows.every(r => r.listedLive === false) && !rows.rows.some(r => r.id === OFF))
  check("the mechanical title no longer needs the deepseek- prefix: 'v4-flash' reads 'V4 Flash'", pins.deepseekDisplayName(OFF) === 'V4 Flash', String(pins.deepseekDisplayName(OFF)))
  check('a pinned id still reads its pin name; the retired alias still folds', pins.deepseekDisplayName(PRO) === 'DeepSeek V4 Pro' && pins.deepseekDisplayName('deepseek-v4-flash') === 'DeepSeek V4.1 Flash')
  check("the hand-typed grammar is untouched: 'v4-flash' is not a deepseek- spelling", pins.isDeepseekModelId(OFF) === false && pins.isDeepseekModelId(PRO) === true)
}

section('2 · a list is a list: no deepseek- id at all is still the account\'s list')
{
  const landed = await catalogue.fetchDeepseekLiveModels({ baseUrl: 'http://127.0.0.1:1', key: 'sk-fixture', fetchImpl: pageFetch(OFF_ONLY) }).then(r => r.models.map(m => m.id).join(','), (e: Error) => `threw: ${e.message}`)
  check('a page whose only id carries no deepseek- prefix lands as one model, never a non-catalogue-view refusal', landed === OFF, landed)
  const both = await catalogue.fetchDeepseekLiveModels({ baseUrl: 'http://127.0.0.1:1', key: 'sk-fixture', fetchImpl: pageFetch(LIST) })
  check('the two-row page lands both ids with a fetch stamp', both.models.map(m => m.id).join(',') === `${PRO},${OFF}` && both.fetchedAtMs > 0)
  const named = catalogue.decodeDeepseekModel({ id: OFF, object: 'model', display_name: '  V4 Flash  ' })
  check('a stated display_name decodes trimmed; an unstated one stays absent', named?.displayName === 'V4 Flash' && catalogue.decodeDeepseekModel({ id: OFF })?.displayName === undefined, JSON.stringify(named))
  check('the shape check stands: a row without a string id is skipped', catalogue.decodeDeepseekModel({ object: 'model' }) === undefined && catalogue.decodeDeepseekModel('v4-flash') === undefined)
}

section('3 · signed in with the stub list: the off-grammar id routes and paints by where it came from')
{
  writeStoredDeepseekApiKey('sk-deepseek-provenance-stored-000001')
  catalogue.__resetDeepseekCatalogueForTest()
  const snapshot = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(LIST) })
  check('the stored key opens the door and the list lands with both ids', snapshot?.models.length === 2 && snapshot.fetchedAtMs > 0 && snapshot.lastError === undefined, JSON.stringify(snapshot))
  check(`cachedLiveIds() = {${PRO}, ${OFF}}`, ids().join(',') === `${PRO},${OFF}`, ids().join(','))
  check('the set is the snapshot\'s own (memoised, not rebuilt per read)', liveIds !== undefined && liveIds() === liveIds())
  const derived = catalogue.deepseekCatalogueRows()
  check('the rows hold BOTH ids, the pinned id first', derived.rows.map(r => r.id).join(',') === `${PRO},${OFF}`, derived.rows.map(r => r.id).join(','))
  const off = derived.rows.find(r => r.id === OFF)
  check("the off-grammar row paints under its mechanical name, listedLive, dated by the fetch, no invented window", off?.displayName === 'V4 Flash' && off?.listedLive === true && off?.contextWindow === undefined && /^\d{4}-\d{2}-\d{2}$/.test(off?.observedAt ?? ''), JSON.stringify(off))
  check('the source is the live list counting both', derived.source.kind === 'live' && derived.source.count === 2, JSON.stringify(derived.source))
  const lane = keyLanePins('deepseek')
  check('keyLanePins reads both rows, the off-grammar one live', lane.map(p => p.id).join(',') === `${PRO},${OFF}` && lane.every(p => p.listedLive === true), JSON.stringify(lane))
  const options = getModelOptions().filter(o => o.group === DEEPSEEK_MODEL_GROUP)
  const offRow = options.find(o => o.value === OFF)
  check("the picker's DeepSeek section lists v4-flash as a selectable row under its live name", offRow !== undefined && offRow.unavailable === undefined && offRow.label === 'V4 Flash', JSON.stringify(offRow))
  check('the section order follows the rows (pinned id first, then the live id)', options.map(o => o.value).join(',') === `${PRO},${OFF}`, options.map(o => o.value).join(','))
  const described = router.describeDeepseekProvider()
  check('the router catalogue carries the off-grammar id with the lane\'s effort words', described.catalogueSource === 'live-discovery' && described.catalogue.some(e => e.id === OFF && e.efforts.join(',') === 'low,high,max' && e.displayLabel === 'V4 Flash'), JSON.stringify(described.catalogue.map(e => e.id)))
  check('the seat listing and the folding entry lookup both find it', router.listDeepseekModels().some(m => m.ref.model === OFF) && router.deepseekCatalogueEntry(OFF)?.displayLabel === 'V4 Flash')
  check('the frontier line counts both rows live', providerFrontierLine('deepseek') === 'frontier: DeepSeek V4 Pro · 2 models live', String(providerFrontierLine('deepseek')))
  const dial = (model: string, effort: string): string | undefined =>
    (wire.buildDeepseekExtras({ wireModel: model, effortValue: effort, thinkingEnabled: true, maxOutputTokensOverride: undefined }) as { reasoning_effort?: string }).reasoning_effort
  check('the wire effort dial answers the off-grammar id exactly as the pinned id (the family decided the lane, not the prefix)', ['low', 'high', 'max', 'medium', 'xhigh'].every(effort => dial(OFF, effort) === dial(PRO, effort)) && dial(OFF, 'high') === 'high' && dial(OFF, 'max') === 'max', JSON.stringify(['low', 'high', 'max', 'medium', 'xhigh'].map(e => [e, dial(OFF, e), dial(PRO, e)])))
}

section('4 · the endpoint\'s own name wins over the mechanical title')
{
  catalogue.__resetDeepseekCatalogueForTest()
  await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(NAMED_LIST) })
  const off = catalogue.deepseekCatalogueRows().rows.find(r => r.id === OFF)
  check('a stated display_name paints the row', off?.displayName === 'V4 Flash (the endpoint names it)' && off?.listedLive === true, JSON.stringify(off))
  const pro = catalogue.deepseekCatalogueRows().rows.find(r => r.id === PRO)
  check('a pinned id keeps its pin name', pro?.displayName === 'DeepSeek V4 Pro')
  check('the live ids are unchanged by the naming', ids().join(',') === `${PRO},${OFF}`)
}

section('5 · a list holding only the off-grammar id')
{
  catalogue.__resetDeepseekCatalogueForTest()
  const only = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(OFF_ONLY) })
  check('the refresh lands it as a live list, no error labelled', only?.models.length === 1 && only.lastError === undefined, JSON.stringify(only))
  const derived = catalogue.deepseekCatalogueRows()
  check('the rows are that one live row', derived.rows.map(r => r.id).join(',') === OFF && derived.source.kind === 'live' && derived.source.count === 1, JSON.stringify(derived))
  check('cachedLiveIds() names it alone', ids().join(',') === OFF, ids().join(','))
  check('the frontier line follows the one live row', providerFrontierLine('deepseek') === 'frontier: V4 Flash · 1 model live', String(providerFrontierLine('deepseek')))
}

section('6 · a failed read, a stale list, a departed key')
{
  catalogue.__resetDeepseekCatalogueForTest()
  const failed = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: statusFetch(503) })
  check('a failed first read: no rows, an error, nothing live', failed?.models.length === 0 && (failed?.lastError ?? '').includes('HTTP 503') && ids().length === 0, JSON.stringify(failed))
  check('the rows fall back to the pins', catalogue.deepseekCatalogueRows().source.kind === 'pin')
  catalogue.__resetDeepseekCatalogueForTest()
  let t = 5_000_000
  const now = () => t
  await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: pageFetch(LIST), now })
  t += 1_000
  const stale = await catalogue.refreshDeepseekCatalogue({ force: true, fetchImpl: statusFetch(503), now })
  check('a later failure keeps the rows stale-but-labelled', stale?.models.length === 2 && (stale?.lastError ?? '').includes('HTTP 503'))
  check('the ids the picker still paints are the ids that still route (route ≡ paint)', ids().join(',') === `${PRO},${OFF}` && catalogue.deepseekCatalogueRows().rows.some(r => r.id === OFF), ids().join(','))
  process.env.DEEPSEEK_API_KEY = 'sk-deepseek-provenance-env-000001'
  check('another credential never reads this key\'s list: the env key sees nothing live', ids().length === 0 && catalogue.deepseekCatalogueRows().source.kind === 'pin', ids().join(','))
  delete process.env.DEEPSEEK_API_KEY
  check('back on the stored key the list is there again', ids().join(',') === `${PRO},${OFF}`)
  writeStoredDeepseekApiKey(null)
  check('signed out, the cached list no longer answers', ids().length === 0 && catalogue.getCachedDeepseekCatalogue() === null, ids().join(','))
  catalogue.__resetDeepseekCatalogueForTest()
}

section('7 · the shape: the prefix decides nothing on the catalogue road')
{
  const source = readFileSync(join(ROOT, 'src/services/providers/deepseek/deepseekCatalogue.ts'), 'utf8')
  check('the catalogue reads no grammar predicate (no non-catalogue-view guard, no row filter by prefix)', !source.includes('isDeepseekModelId') && !source.includes('non-catalogue view') && !/startsWith\('deepseek/.test(source))
  check('the catalogue exports the seam\'s read by its exact name and shape', source.includes('export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string>'))
  check('the live-id read folds the retired alias like the rows do', /cachedLiveIds[\s\S]*?deepseekCurrentModelId\(m\.id\.trim\(\)\.toLowerCase\(\)\)/.test(source))
  const pinsSource = readFileSync(join(ROOT, 'src/services/providers/deepseek/deepseekPins.ts'), 'utf8')
  const nameBody = pinsSource.slice(pinsSource.indexOf('export function deepseekDisplayName'), pinsSource.indexOf('\n}', pinsSource.indexOf('export function deepseekDisplayName')))
  check('the display name has no family gate; the hand-typed grammar predicate stays for the typed road', !nameBody.includes('isDeepseekModelId') && pinsSource.includes('export function isDeepseekModelId'))
  const options = readFileSync(join(ROOT, 'src/utils/model/modelOptions.ts'), 'utf8')
  const between = (text: string, from: string, to: string): string => {
    const a = text.indexOf(from)
    const b = text.indexOf(to, a + from.length)
    return a < 0 ? '' : text.slice(a, b < 0 ? undefined : b)
  }
  const pinsBody = between(options, 'export function keyLanePins', '\nexport function')
  const groupBody = between(options, 'export function keyLaneGroupRows', '\nexport function')
  check('no picker row composer re-filters the DeepSeek rows by prefix', pinsBody.includes('deepseekCatalogueRows') && !/isDeepseekModelId|startsWith\('deepseek|\/\^deepseek/.test(pinsBody + groupBody))
  const adapter = readFileSync(join(ROOT, 'src/utils/router/providers/deepseek.ts'), 'utf8')
  check('the router adapter lists the catalogue rows without a prefix filter', adapter.includes('deepseekCatalogueRows()') && !/isDeepseekModelId|startsWith\('deepseek/.test(adapter))
}

console.log(failures === 0 ? '\n ✅ DEEPSEEK LIVE PROVENANCE — GREEN' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
