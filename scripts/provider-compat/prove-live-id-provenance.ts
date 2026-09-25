#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_CONSOLE_MODEL',
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
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

const OFF_GRAMMAR = { moonshot: 'k3', deepseek: 'v4-flash', openai: 'sol-6', gemini: 'nano-banana-pro' } as const
const SHARED = 'shared-list-id'
type Family = keyof typeof OFF_GRAMMAR
const lists: Record<Family, string[]> = { moonshot: [], deepseek: [], openai: [], gemini: [] }
const openaiList = (ids: string[]): unknown => ({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'fixture', created: 1 })) })
const geminiList = (ids: string[]): unknown => ({ models: ids.map(id => ({ name: `models/${id}`, displayName: id, supportedGenerationMethods: ['generateContent'], inputTokenLimit: 131072 })) })
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled === 'http://127.0.0.1:1/moonshot/v1/models') return Response.json(openaiList(lists.moonshot))
  if (spelled === 'http://127.0.0.1:1/deepseek/models') return Response.json(openaiList(lists.deepseek))
  if (spelled === 'http://127.0.0.1:1/openai/v1/models') return Response.json(openaiList(lists.openai))
  if (spelled.startsWith('http://127.0.0.1:1/gemini/v1beta/models')) return Response.json(geminiList(lists.gemini))
  if (spelled.includes('/v1/models')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch

;(await import('../../src/utils/config.ts')).enableConfigs()
const idSpaces = await import('../../src/services/providers/idSpaces.ts')
const { classifyModelRoute, recognizeModelId } = idSpaces
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const engine = await import('../../src/utils/swarm/engineDispatch.ts')
const { getModelOptions, isProviderActionRow, MOONSHOT_MODEL_GROUP, DEEPSEEK_MODEL_GROUP, OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.ts')
const { GEMINI_MODEL_GROUP } = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const moonshot = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const deepseek = await import('../../src/services/providers/deepseek/deepseekCatalogue.ts')
const openai = await import('../../src/services/providers/openai/openaiCatalogue.ts')
const gemini = await import('../../src/services/providers/gemini/geminiCatalogue.ts')
const { validateModel } = await import('../../src/utils/model/validateModel.ts')

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
    check(`[${family}] '${id}' is unrecognised with no list to check, and no live id is cached`, classifyModelRoute(id).kind === 'unrecognised' && declaredRouteOf(id) === null && liveIds(family).size === 0 && !engine.isExactEngineModelId(id), `${classifyModelRoute(id).kind} · ${liveIds(family).size} cached`)
  }
  check('the grammar still answers a typed id with no list: kimi-k3 · deepseek-v4-pro · gpt-5.6-sol · gemini-3-pro', declaredRouteOf('kimi-k3') === 'moonshot' && declaredRouteOf('deepseek-v4-pro') === 'deepseek' && declaredRouteOf('gpt-5.6-sol') === 'openai' && declaredRouteOf('gemini-3-pro') === 'gemini')
  const order = (idSpaces as { LIVE_LIST_FAMILIES?: readonly string[] }).LIVE_LIST_FAMILIES
  check('the seam walks the four bare-id families in the fixed order moonshot · deepseek · openai · gemini', order?.join(',') === 'moonshot,deepseek,openai,gemini', String(order?.join(',')))
}

for (const family of Object.keys(OFF_GRAMMAR) as Family[]) {
  const id = OFF_GRAMMAR[family]
  section(`§${family}: an off-grammar id that arrived in the signed-in account's list belongs to ${family}`)
  resetAll()
  await signIn(family, [id])
  check(`[${family}] the catalogue answers cachedLiveIds holding '${id}'`, typeof readers[family].cachedLiveIds === 'function' && liveIds(family).has(id), typeof readers[family].cachedLiveIds === 'function' ? [...liveIds(family)].join(',') : 'no cachedLiveIds export')
  check(`[${family}] '${id}' routes to ${family} by provenance (classify · recognise · declaredRouteOf)`, classifyModelRoute(id).kind === 'route' && (classifyModelRoute(id) as { route?: string }).route === family && recognizeModelId(id).kind === 'declared' && declaredRouteOf(id) === family, `${JSON.stringify(classifyModelRoute(id))}`)
  check(`[${family}] the spelling is irrelevant: upper case and a Mercury annotation route the same`, declaredRouteOf(id.toUpperCase()) === family && declaredRouteOf(`${id}[1m]`) === family)
  check(`[${family}] '${id}' is an exact engine id on this account`, engine.isExactEngineModelId(id) && engine.unrecognisedModelWordRefusal(id) === null)
  check(`[${family}] '${id}' paints in the ${family} section of the picker`, rowsOf(family).includes(id), rowsOf(family).join(','))
  const typed = await validateModel(id)
  check(`[${family}] the typed /model road validates '${id}' on its own family's road`, typed.valid, typed.error)
  const dispatched = await dispatchOf(id)
  check(`[${family}] the exact-id dispatch road resolves '${id}' on the ${family} backend`, dispatched.startsWith(`${family}:`), dispatched)
  signOut(family)
  resetAll()
  check(`[${family}] signed out again, '${id}' is unrecognised — the list is the only provenance`, classifyModelRoute(id).kind === 'unrecognised' && liveIds(family).size === 0)
}

section('§order: when two signed-in accounts list one id, the first family in the fixed order wins')
{
  resetAll()
  await signIn('deepseek', [SHARED])
  await signIn('gemini', [SHARED])
  check(`both lists hold '${SHARED}' and the earlier family (deepseek) wins over gemini`, liveIds('deepseek').has(SHARED) && liveIds('gemini').has(SHARED) && declaredRouteOf(SHARED) === 'deepseek', String(declaredRouteOf(SHARED)))
  await signIn('moonshot', [SHARED])
  check('a Moonshot list holding the same id outranks both (moonshot leads the order)', liveIds('moonshot').has(SHARED) && declaredRouteOf(SHARED) === 'moonshot', String(declaredRouteOf(SHARED)))
  signOut('moonshot')
  moonshot.__resetMoonshotCatalogueForTest()
  check('with Moonshot signed out the id falls back to the next holder in order', declaredRouteOf(SHARED) === 'deepseek', String(declaredRouteOf(SHARED)))
  signOut('deepseek')
  deepseek.__resetDeepseekCatalogueForTest()
  check('…then to gemini, the last holder', declaredRouteOf(SHARED) === 'gemini', String(declaredRouteOf(SHARED)))
  signOut('gemini')
  resetAll()
  check('…and to nobody once every list is gone', classifyModelRoute(SHARED).kind === 'unrecognised')
}

section('§grammar: provenance outranks the prefix, and a qualified namespace outranks provenance')
{
  resetAll()
  await signIn('moonshot', ['gpt-listed-by-moonshot', 'k3'])
  check("a gpt- spelled id that arrived in Moonshot's list routes to moonshot — where it came from, not its prefix", declaredRouteOf('gpt-listed-by-moonshot') === 'moonshot', String(declaredRouteOf('gpt-listed-by-moonshot')))
  check('a gpt- id no list holds still routes to openai by grammar', declaredRouteOf('gpt-5.6-sol') === 'openai')
  check('a qualified namespace is a reserved word: compat/k3 routes to the compat slot even while Moonshot lists k3', declaredRouteOf('compat/k3') === 'openai-compat' && declaredRouteOf('openrouter/moonshot/k3') === 'openrouter')
  check('a carrier-shaped bare slug is never looked up in a list', classifyModelRoute('moonshot/k3').kind === 'unrecognised' && (classifyModelRoute('moonshot/k3') as { carrierShaped?: boolean }).carrierShaped === true)
  check('an absent id stays absence; a first-party id stays first-party', classifyModelRoute('').kind === 'absence' && declaredRouteOf('claude-sonnet-5') === 'anthropic')
  signOut('moonshot')
  resetAll()
}

section('§seams, source-shaped')
{
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8')
  const seam = src('services/providers/idSpaces.ts')
  check('recognition asks the live lists after the qualified namespaces and before the bare grammar', seam.indexOf('const listed = liveListedRouteOf(lowered, env)') > seam.indexOf('if (qualified !== undefined) return') && seam.indexOf('const listed = liveListedRouteOf(lowered, env)') < seam.indexOf('for (const space of PROVIDER_ID_SPACES) {\n    if (space.bareAliases'))
  check('the seam reads each family lazily by literal require and never fetches', seam.includes("require('./moonshot/moonshotCatalogue.js')") && seam.includes("require('./deepseek/deepseekCatalogue.js')") && seam.includes("require('./openai/openaiCatalogue.js')") && seam.includes("require('./gemini/geminiCatalogue.js')") && !seam.includes('fetch(') && !seam.includes('await '))
  const dispatch = src('utils/swarm/engineDispatch.ts')
  check('the exact-id road asks the lists first, then the grammar, and reads the lists on demand for an unrecognised bare id', dispatch.includes('liveListedRouteOf(v) !== undefined ||') && dispatch.includes('const listed = liveListedRouteOf(id)') && dispatch.includes('await readLiveListsForBareId(modelParam)'))
  const router = src('services/providers/callModelRouter.ts')
  check('the dispatch router reads the lists for an unrecognised bare id before classifying', router.includes('const verdict = await classifyAfterLiveLists(params.options.model)'))
  const typedRoad = src('utils/model/validateModel.ts')
  check('the typed /model road reads the lists for an unrecognised bare id before choosing its family', typedRoad.includes("early.kind === 'unrecognised' && !early.carrierShaped"))
  const owner = src('services/providers/moonshot/moonshotCatalogue.ts')
  check("Moonshot's list is a list: no grammar filter on the rows, no grammar guard on the fetch", !owner.includes('isKimiModelId') && owner.includes('export function cachedLiveIds('))
}

globalThis.fetch = realFetch
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-live-id-provenance: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
