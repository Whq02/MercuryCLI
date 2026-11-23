#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'live-id-provenance-'))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = home
for (const key of [
  'MERCURY_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'HF_TOKEN',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'XAI_MANAGEMENT_API_KEY',
  'MODEL_API_KEY',
  'META_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'CI',
  'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const base of [
  'ANTHROPIC_BASE_URL',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_CODING_BASE',
]) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.MERCURY_MOONSHOT_API_BASE = 'http://127.0.0.1:1/moonshot/v1'
process.env.MERCURY_DEEPSEEK_API_BASE = 'http://127.0.0.1:1/deepseek'
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1/openai/v1'
process.env.MERCURY_GEMINI_API_BASE = 'http://127.0.0.1:1/gemini/v1beta'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail?: string): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const OFF_GRAMMAR = { moonshot: 'k3', deepseek: 'v4-flash', openai: 'sol-6', gemini: 'argon-pro' } as const
const SHARED = 'shared-list-id'
type Family = keyof typeof OFF_GRAMMAR
const lists: Record<Family, string[]> = { moonshot: [], deepseek: [], openai: [], gemini: [] }
const openaiList = (ids: string[]): unknown => ({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'fixture', created: 1, supported_reasoning_efforts: ['low', 'medium', 'high'] })) })
const geminiList = (ids: string[]): unknown => ({ models: ids.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 131072 })) })
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled === 'http://127.0.0.1:1/moonshot/v1/models') return Response.json(openaiList(lists.moonshot))
  if (spelled === 'http://127.0.0.1:1/deepseek/models') return Response.json(openaiList(lists.deepseek))
  if (spelled.startsWith('http://127.0.0.1:1/openai/v1/models')) return Response.json(openaiList(lists.openai))
  if (spelled.startsWith('http://127.0.0.1:1/gemini/v1beta/models')) return Response.json(geminiList(lists.gemini))
  if (spelled.includes('/v1/models')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch

;(await import('../../src/platform/settings/config.ts')).enableConfigs()
const idSpaces = await import('../../src/models/roads/idSpaces.ts')
const { classifyModelRoute, recognizeModelId } = idSpaces
const { declaredRouteOf } = await import('../../src/models/roads/routeLaw.ts')
const engine = await import('../../src/crew/crewmates/engineDispatch.ts')
const { getModelOptions, isProviderActionRow, MOONSHOT_MODEL_GROUP, DEEPSEEK_MODEL_GROUP, OPENAI_MODEL_GROUP } = await import('../../src/models/catalogue/modelOptions.ts')
const { GEMINI_MODEL_GROUP } = await import('../../src/models/roads/gemini/geminiCatalogue.ts')
const moonshot = await import('../../src/models/roads/moonshot/moonshotCatalogue.ts')
const deepseek = await import('../../src/models/roads/deepseek/deepseekCatalogue.ts')
const openai = await import('../../src/models/roads/openai/openaiCatalogue.ts')
const gemini = await import('../../src/models/roads/gemini/geminiCatalogue.ts')
const { validateModel } = await import('../../src/models/roads/validateModel.ts')

type Reader = { cachedLiveIds?: (env?: NodeJS.ProcessEnv) => ReadonlySet<string> }
const readers: Record<Family, Reader> = { moonshot: moonshot as Reader, deepseek: deepseek as Reader, openai: openai as Reader, gemini: gemini as Reader }
const groups: Record<Family, string> = { moonshot: MOONSHOT_MODEL_GROUP, deepseek: DEEPSEEK_MODEL_GROUP, openai: OPENAI_MODEL_GROUP, gemini: GEMINI_MODEL_GROUP }
const liveIds = (family: Family): ReadonlySet<string> => readers[family].cachedLiveIds?.() ?? new Set()
const rowsOf = (family: Family): string[] => getModelOptions().filter(option => option.group === groups[family] && !isProviderActionRow(option.value)).map(option => option.value)
const resetAll = (): void => {
  moonshot.__resetMoonshotCatalogueForTest()
  deepseek.__resetDeepseekCatalogueForTest()
  openai.__resetOpenaiCatalogueForTest()
  gemini.__resetGeminiCatalogueForTest()
}
async function signIn(family: Family, ids: string[]): Promise<void> {
  lists[family] = ids
  if (family === 'moonshot') {
    process.env.MOONSHOT_API_KEY = 'fixture-moonshot-key'
    await moonshot.refreshMoonshotCatalogue({ force: true })
  } else if (family === 'deepseek') {
    process.env.DEEPSEEK_API_KEY = 'fixture-deepseek-key'
    await deepseek.refreshDeepseekCatalogue({ force: true })
  } else if (family === 'openai') {
    process.env.OPENAI_API_KEY = 'fixture-openai-key'
    await openai.refreshOpenaiCatalogue('api-key', { force: true })
  } else {
    process.env.GEMINI_API_KEY = 'fixture-gemini-key'
    await gemini.refreshGeminiCatalogue('api-key', { force: true })
  }
}
function signOut(family: Family): void {
  lists[family] = []
  delete process.env[{ moonshot: 'MOONSHOT_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' }[family]]
}
const dispatchOf = (id: string): Promise<string> => engine.resolveEngineDispatch(id).then(resolved => `${resolved?.backend ?? 'null'}:${resolved?.model ?? ''}`, error => `threw ${error instanceof Error ? error.message : String(error)}`)

section('§0 signed out everywhere: no list, every off-grammar id is unrecognised, every on-grammar id routes by prefix')
{
  for (const family of Object.keys(OFF_GRAMMAR) as Family[]) {
    const id = OFF_GRAMMAR[family]
    check(`[${family}] '${id}' is unrecognised with no list to check, and no live id is cached`, classifyModelRoute(id).kind === 'unrecognised' && declaredRouteOf(id) === null && liveIds(family).size === 0 && !engine.isExactEngineModelId(id), `${classifyModelRoute(id).kind} · ${liveIds(family).size} cached · a signed-out id must stay unrecognised: fix classifyModelRoute in src/models/roads/idSpaces.ts or the catalogue's cachedLiveIds`)
  }
  check('the grammar still answers a typed id with no list: kimi-k3 · deepseek-v4-pro · gpt-5.6-sol · gemini-3-pro', declaredRouteOf('kimi-k3') === 'moonshot' && declaredRouteOf('deepseek-v4-pro') === 'deepseek' && declaredRouteOf('gpt-5.6-sol') === 'openai' && declaredRouteOf('gemini-3-pro') === 'gemini', 'prefix grammar lost an id: fix declaredRouteOf in src/models/roads/routeLaw.ts')
  const order = (idSpaces as { LIVE_LIST_FAMILIES?: readonly string[] }).LIVE_LIST_FAMILIES
  check('the seam walks the ten bare-id families in the fixed order moonshot · deepseek · xai · meta · openai · gemini · mistral · minimax · cohere · qwen', order?.join(',') === 'moonshot,deepseek,xai,meta,openai,gemini,mistral,minimax,cohere,qwen', `${String(order?.join(','))} · change LIVE_LIST_FAMILIES in src/models/roads/idSpaces.ts back to the fixed order`)
}

for (const family of Object.keys(OFF_GRAMMAR) as Family[]) {
  const id = OFF_GRAMMAR[family]
  section(`§${family}: an off-grammar id that arrived in the signed-in account's list belongs to ${family}`)
  resetAll()
  await signIn(family, [id])
  check(`[${family}] the catalogue answers cachedLiveIds holding '${id}'`, typeof readers[family].cachedLiveIds === 'function' && liveIds(family).has(id), typeof readers[family].cachedLiveIds === 'function' ? [...liveIds(family)].join(',') + ` · the ${family} catalogue under src/models/roads/${family}/ must cache the fetched list in cachedLiveIds` : `no cachedLiveIds export: add it to the ${family} catalogue under src/models/roads/${family}/`)
  check(`[${family}] '${id}' routes to ${family} by provenance (classify · recognise · declaredRouteOf)`, classifyModelRoute(id).kind === 'route' && (classifyModelRoute(id) as { route?: string }).route === family && recognizeModelId(id).kind === 'declared' && declaredRouteOf(id) === family, `${JSON.stringify(classifyModelRoute(id))} · an id in a signed-in list must route to that family: fix classifyModelRoute in src/models/roads/idSpaces.ts and declaredRouteOf in src/models/roads/routeLaw.ts`)
  check(`[${family}] the spelling is irrelevant: upper case and a Mercury annotation route the same`, declaredRouteOf(id.toUpperCase()) === family && declaredRouteOf(`${id}[1m]`) === family, 'live-list lookup must ignore case and the [1m] annotation: fix declaredRouteOf in src/models/roads/routeLaw.ts or classifyModelRoute in src/models/roads/idSpaces.ts')
  check(`[${family}] '${id}' is an exact engine id on this account`, engine.isExactEngineModelId(id) && engine.unrecognisedModelWordRefusal(id) === null, 'a live-listed id must count as an exact engine id: fix isExactEngineModelId and unrecognisedModelWordRefusal in src/crew/crewmates/engineDispatch.ts')
  check(`[${family}] '${id}' paints in the ${family} section of the picker`, rowsOf(family).includes(id), `${rowsOf(family).join(',')} · the live id must appear in its family group: fix getModelOptions in src/models/catalogue/modelOptions.ts`)
  const typed = await validateModel(id)
  check(`[${family}] the typed /model road validates '${id}' on its own family's road`, typed.valid, `${typed.error} · fix validateModel in src/models/roads/validateModel.ts to admit live-listed ids`)
  const dispatched = await dispatchOf(id)
  check(`[${family}] the exact-id dispatch road resolves '${id}' on the ${family} backend`, dispatched.startsWith(`${family}:`), `${dispatched} · fix resolveEngineDispatch in src/crew/crewmates/engineDispatch.ts`)
  signOut(family)
  resetAll()
  check(`[${family}] signed out again, '${id}' is unrecognised — the list is the only provenance`, classifyModelRoute(id).kind === 'unrecognised' && liveIds(family).size === 0, 'signing out must clear the family live list: fix the catalogue reset and cachedLiveIds under src/models/roads/' + family + '/')
}

section('§order: when two signed-in accounts list one id, the first family in the fixed order wins')
{
  resetAll()
  await signIn('deepseek', [SHARED])
  await signIn('gemini', [SHARED])
  check(`both lists hold '${SHARED}' and the earlier family (deepseek) wins over gemini`, liveIds('deepseek').has(SHARED) && liveIds('gemini').has(SHARED) && declaredRouteOf(SHARED) === 'deepseek', `${String(declaredRouteOf(SHARED))} · ties follow LIVE_LIST_FAMILIES order: fix src/models/roads/idSpaces.ts`)
  await signIn('moonshot', [SHARED])
  check('a Moonshot list holding the same id outranks both (moonshot leads the order)', liveIds('moonshot').has(SHARED) && declaredRouteOf(SHARED) === 'moonshot', `${String(declaredRouteOf(SHARED))} · ties follow LIVE_LIST_FAMILIES order: fix src/models/roads/idSpaces.ts`)
  signOut('moonshot')
  moonshot.__resetMoonshotCatalogueForTest()
  check('with Moonshot signed out the id falls back to the next holder in order', declaredRouteOf(SHARED) === 'deepseek', `${String(declaredRouteOf(SHARED))} · a signed-out family must drop out of the lookup: fix src/models/roads/idSpaces.ts`)
  signOut('deepseek')
  deepseek.__resetDeepseekCatalogueForTest()
  check('…then to gemini, the last holder', declaredRouteOf(SHARED) === 'gemini', `${String(declaredRouteOf(SHARED))} · a signed-out family must drop out of the lookup: fix src/models/roads/idSpaces.ts`)
  signOut('gemini')
  resetAll()
  check('…and to nobody once every list is gone', classifyModelRoute(SHARED).kind === 'unrecognised', 'with every list gone the id must be unrecognised: fix classifyModelRoute in src/models/roads/idSpaces.ts')
}

section('§grammar: provenance outranks the prefix, and a qualified namespace outranks provenance')
{
  resetAll()
  await signIn('moonshot', ['gpt-listed-by-moonshot', 'k3'])
  check("a gpt- spelled id that arrived in Moonshot's list routes to moonshot — where it came from, not its prefix", declaredRouteOf('gpt-listed-by-moonshot') === 'moonshot', `${String(declaredRouteOf('gpt-listed-by-moonshot'))} · list provenance must outrank the prefix: fix declaredRouteOf in src/models/roads/routeLaw.ts`)
  check('a gpt- id no list holds still routes to openai by grammar', declaredRouteOf('gpt-5.6-sol') === 'openai', 'prefix grammar must still route gpt- ids: fix declaredRouteOf in src/models/roads/routeLaw.ts')
  check('a qualified namespace is a reserved word: compat/k3 routes to the compat slot even while Moonshot lists k3', declaredRouteOf('compat/k3') === 'openai-compat' && declaredRouteOf('openrouter/moonshot/k3') === 'openrouter', 'a qualified namespace must outrank list provenance: fix declaredRouteOf in src/models/roads/routeLaw.ts')
  check('a carrier-shaped bare slug is never looked up in a list', classifyModelRoute('moonshot/k3').kind === 'unrecognised' && (classifyModelRoute('moonshot/k3') as { carrierShaped?: boolean }).carrierShaped === true, 'a carrier-shaped slug must skip the list lookup: fix classifyModelRoute in src/models/roads/idSpaces.ts')
  check('an absent id stays absence; a first-party id stays first-party', classifyModelRoute('').kind === 'absence' && declaredRouteOf('claude-sonnet-5') === 'anthropic', 'fix classifyModelRoute in src/models/roads/idSpaces.ts and declaredRouteOf in src/models/roads/routeLaw.ts')
  signOut('moonshot')
  resetAll()
}

for (const lane of [
  { family: 'xai', key: 'XAI_API_KEY', baseKey: 'MERCURY_XAI_API_BASE', id: 'grok-fixture-live', group: 'Mercury — xAI models' },
  { family: 'meta', key: 'MODEL_API_KEY', baseKey: 'MERCURY_META_API_BASE', id: 'muse-spark-fixture-live', group: 'Mercury — Meta models' },
  { family: 'mistral', key: 'MISTRAL_API_KEY', baseKey: 'MERCURY_MISTRAL_API_BASE', id: 'mistral-fixture-live', group: 'Mercury — Mistral models' },
]) {
  const owner = lane.family === 'xai'
    ? await import('../../src/models/roads/xai/xaiCatalogue.ts').then(module => ({ reset: module.__resetXaiCatalogueForTest, refresh: module.refreshXaiCatalogue, ids: module.cachedLiveIds }))
    : lane.family === 'meta'
      ? await import('../../src/models/roads/meta/metaCatalogue.ts').then(module => ({ reset: module.__resetMetaCatalogueForTest, refresh: module.refreshMetaCatalogue, ids: module.cachedLiveIds }))
      : await import('../../src/models/roads/mistral/mistralCatalogue.ts').then(module => ({ reset: module.__resetMistralCatalogueForTest, refresh: module.refreshMistralCatalogue, ids: module.cachedLiveIds }))
  process.env[lane.baseKey] = `http://127.0.0.1:1/${lane.family}/v1`
  process.env[lane.key] = `${lane.family}-fixture-key`
  owner.reset()
  await owner.refresh({ force: true, fetchImpl: (async () => Response.json(openaiList([lane.id]))) as typeof fetch })
  check(`${lane.family}: the credential-scoped live set holds the unknown supported model`, owner.ids().has(lane.id) && declaredRouteOf(lane.id) === lane.family, `fix ${lane.family}'s catalogue under src/models/roads/${lane.family}/ so cachedLiveIds holds the fetched id, and declaredRouteOf in src/models/roads/routeLaw.ts`)
  check(`${lane.family}: the fetched row paints only in its own group`, getModelOptions().some(row => row.group === lane.group && row.value === lane.id && !row.unavailable), 'fix getModelOptions in src/models/catalogue/modelOptions.ts')
  const validation = await validateModel(lane.id)
  check(`${lane.family}: its typed model road admits the fetched id`, validation.valid, `${validation.error} · fix validateModel in src/models/roads/validateModel.ts`)
  const dispatch = await dispatchOf(lane.id)
  check(`${lane.family}: the exact-id road uses its own backend`, dispatch === `${lane.family}:${lane.id}`, `${dispatch} · fix resolveEngineDispatch in src/crew/crewmates/engineDispatch.ts`)
  process.env[lane.key] = `${lane.family}-other-fixture-key`
  check(`${lane.family}: another key cannot borrow the first key's live provenance`, owner.ids().size === 0, `cachedLiveIds in src/models/roads/${lane.family}/ must key the live set to the credential`)
  delete process.env[lane.key]
  owner.reset()
}


globalThis.fetch = realFetch
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-live-id-provenance: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
