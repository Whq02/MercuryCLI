#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

console.log('============================================================')
console.log(' PROVAUTH — Gemini live-id provenance (fixtures)')
console.log('============================================================')

const savedEnv: Record<string, string | undefined> = {}
for (const key of [
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'MERCURY_CONFIG_DIR',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_GEMINI_OAUTH_AUTH_BASE',
  'MERCURY_GEMINI_OAUTH_TOKEN_BASE',
  'MERCURY_GEMINI_OAUTH_CLIENT_ID',
  'MERCURY_GEMINI_OAUTH_CLIENT_SECRET',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_MODEL',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
]) {
  savedEnv[key] = process.env[key]
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-gemini-provenance-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:1'

const ROOT = join(import.meta.dir, '..', '..')
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const catalogue = await import('../../src/services/providers/gemini/geminiCatalogue.js')
const { __resetGeminiCatalogueForTest, getGeminiAvailability, getGeminiModelOptions, refreshGeminiCatalogue, geminiListedModel, geminiContextWindowFor } = catalogue
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.js')
const { getModelOptions } = await import('../../src/utils/model/modelOptions.js')
const { GEMINI_MODEL_GROUP } = catalogue

type LiveIds = (env?: NodeJS.ProcessEnv) => ReadonlySet<string>
const liveIds = (catalogue as { cachedLiveIds?: LiveIds }).cachedLiveIds
const ids = (): string[] => (liveIds ? [...liveIds()].sort() : ['<cachedLiveIds absent>'])

const PRO = 'gemini-3-pro'
const OFF = 'nano-banana-pro'
const PAGE = {
  models: [
    { name: `models/${PRO}`, displayName: 'Gemini 3 Pro', inputTokenLimit: 1_048_576, outputTokenLimit: 65_536, supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true },
    { name: `models/${OFF}`, displayName: 'Nano Banana Pro', inputTokenLimit: 32_768, outputTokenLimit: 8_192, supportedGenerationMethods: ['generateContent'] },
    { name: 'models/embedding-fixture', displayName: 'Embedding Fixture', supportedGenerationMethods: ['embedContent'] },
  ],
}
const pageFetch = (page: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
const statusFetch = (status: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ error: { code: status } }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

section('1 · signed out: no account, nothing routes by provenance')
{
  __resetGeminiCatalogueForTest()
  check('the catalogue exports cachedLiveIds', typeof liveIds === 'function')
  check('signed out, cachedLiveIds is empty', ids().length === 0, ids().join(','))
  check('the availability is no-account', getGeminiAvailability().state === 'disabled' && (getGeminiAvailability() as { why?: string }).why === 'no-account')
}

section('2 · signed in with the stub list: the generateContent ids are the live ids, whatever their spelling')
process.env.GEMINI_API_KEY = 'AIza-PROVER-000000000000000'
{
  __resetGeminiCatalogueForTest()
  const snapshot = await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: pageFetch(PAGE) })
  check('three rows land, the models/ prefix stripped', snapshot?.models.length === 3 && snapshot.models.map(m => m.id).join(',') === `${PRO},${OFF},embedding-fixture`, JSON.stringify(snapshot?.models.map(m => m.id)))
  check(`cachedLiveIds() = {${PRO}, ${OFF}} — the vendor's generateContent statement filters, never the gemini- prefix`, ids().join(',') === `${PRO},${OFF}`, ids().join(','))
  check('the set is memoised per snapshot', liveIds !== undefined && liveIds() === liveIds())
  const availability = getGeminiAvailability()
  check('the availability chain lists both chat ids in the vendor\'s order', availability.state === 'ready' && availability.ids.join(',') === `${PRO},${OFF}`, JSON.stringify(availability))
}

section('3 · the picker row: painted with the live name; selectable exactly when the routing law routes it')
{
  const routed = declaredRouteOf(OFF) === 'gemini'
  console.log(`  (the routing law in this tree ${routed ? 'routes' : 'does not route'} '${OFF}' — the row's selectability follows it)`)
  const rows = getGeminiModelOptions()
  const offRow = rows.find(r => r.value === OFF)
  check("the off-grammar row is present, under the Gemini group, wearing its live name and its stated window", offRow !== undefined && offRow.group === GEMINI_MODEL_GROUP && offRow.label === 'Nano Banana Pro' && offRow.statedContextWindow === 32_768 && offRow.description === '', JSON.stringify(offRow))
  check("its model-facing description names the live list", (offRow?.descriptionForModel ?? '').startsWith(`Nano Banana Pro (${OFF}) — live-listed generateContent model`), String(offRow?.descriptionForModel))
  check('its selectability follows declaredRouteOf and nothing else', offRow !== undefined && (offRow.unavailable === undefined) === routed && (routed || (offRow.unavailable ?? '').includes('outside the routable')), JSON.stringify({ routed, unavailable: offRow?.unavailable }))
  const proRow = rows.find(r => r.value === PRO)
  check('the grammar row stands beside it, selectable', proRow !== undefined && proRow.unavailable === undefined && proRow.label === 'Gemini 3 Pro', JSON.stringify(proRow))
  check('the embedding row never reaches the picker', !rows.some(r => r.value === 'embedding-fixture'))
  const composed = getModelOptions().filter(o => o.group === GEMINI_MODEL_GROUP)
  check("the composed picker's Gemini section carries the same rows in the same order", composed.map(o => o.value).join(',') === `${PRO},${OFF}` && composed.find(o => o.value === OFF)?.label === 'Nano Banana Pro', composed.map(o => o.value).join(','))
  const listed = geminiListedModel(OFF)
  check('the listed-row reader follows the same law (the row when routed, silence when not)', (listed !== undefined) === routed && (!routed || listed?.inputTokenLimit === 32_768), JSON.stringify(listed))
  check('the context-window reader agrees', (geminiContextWindowFor(OFF) !== undefined) === routed)
  check('the grammar row reads its window either way', geminiContextWindowFor(PRO)?.window === 1_048_576)
}

section('4 · a failed read, a stale list, a departed key')
{
  __resetGeminiCatalogueForTest()
  await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: statusFetch(503) })
  check('a failed first read: nothing live', ids().length === 0 && getGeminiAvailability().state === 'disabled', ids().join(','))
  __resetGeminiCatalogueForTest()
  const landed = await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: pageFetch(PAGE) })
  const stale = await refreshGeminiCatalogue('api-key', { force: true, fetchImpl: statusFetch(503) })
  check('a later failure keeps the rows stale-but-labelled under the first fetch stamp', stale?.models.length === 3 && stale.lastError !== undefined && stale.fetchedAtMs === landed?.fetchedAtMs && stale.fetchedAtMs > 0, JSON.stringify(stale))
  check('the ids the picker still paints are the ids that still route (route ≡ paint)', ids().join(',') === `${PRO},${OFF}` && getGeminiModelOptions().some(r => r.value === OFF), ids().join(','))
  process.env.GOOGLE_API_KEY = 'AIza-OTHER-000000000000000'
  check('another credential never reads this key\'s list', ids().length === 0, ids().join(','))
  delete process.env.GOOGLE_API_KEY
  check('back on the first key the list answers again', ids().join(',') === `${PRO},${OFF}`)
  delete process.env.GEMINI_API_KEY
  check('signed out, the cached list no longer answers', ids().length === 0, ids().join(','))
  __resetGeminiCatalogueForTest()
}

section('5 · the shape: the picker guard reads the routing law; nothing on the Gemini road filters by prefix')
{
  const source = readFileSync(join(ROOT, 'src/services/providers/gemini/geminiCatalogue.ts'), 'utf8')
  check('the catalogue exports the seam\'s read by its exact name and shape', source.includes('export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string>'))
  check('the live ids are the generateContent rows of the active source', /cachedLiveIds[\s\S]*?geminiGenerateModels\(snapshot\)\.map\(m => m\.id\.toLowerCase\(\)\)/.test(source))
  const picker = source.slice(source.indexOf('export function getGeminiModelOptions'), source.indexOf('export function __resetGeminiCatalogueForTest'))
  check("the picker's one guard is the routing law's own verdict", picker.includes("const routed = declaredRouteOf(model.id) === 'gemini'") && picker.includes('geminiGenerateModels(snapshot).map('))
  check('the listed-row reader is guarded by the same law', source.includes("if (declaredRouteOf(model) !== 'gemini') return undefined"))
  const prefix = /startsWith\('gemini|\/\^gemini-|isGeminiModelId/
  for (const file of [
    'src/services/providers/gemini/geminiCatalogue.ts',
    'src/services/providers/gemini/geminiAccounts.ts',
    'src/services/providers/gemini/geminiCallModel.ts',
    'src/services/providers/gemini/geminiClient.ts',
    'src/utils/router/providers/gemini.ts',
    'src/utils/model/modelOptions.ts',
  ]) {
    check(`${file} filters nothing by the gemini- prefix`, !prefix.test(readFileSync(join(ROOT, file), 'utf8')))
  }
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('============================================================')
if (failures > 0) {
  console.error(`❌ ${failures} gemini live-provenance check(s) failed`)
  process.exit(1)
}
console.log('✅ GEMINI LIVE-ID PROVENANCE PROVEN (fixture rig)')
