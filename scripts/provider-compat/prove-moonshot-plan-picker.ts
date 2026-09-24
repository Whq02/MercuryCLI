#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'moonshot-plan-picker-'))
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
  'MERCURY_OPENAI_API_BASE',
  'MERCURY_OPENAI_CHATGPT_BASE',
  'MERCURY_OPENAI_AUTH_BASE',
  'MERCURY_OPENROUTER_API_BASE',
  'MERCURY_GEMINI_API_BASE',
  'MERCURY_DEEPSEEK_API_BASE',
  'MERCURY_HUGGINGFACE_HUB_BASE',
  'MERCURY_HUGGINGFACE_API_BASE',
  'MERCURY_ZAI_API_BASE',
  'MERCURY_MOONSHOT_OAUTH_BASE',
  'MERCURY_MOONSHOT_API_BASE',
]) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.MERCURY_MOONSHOT_CODING_BASE = 'http://127.0.0.1:1/coding/v1'
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

const ALIAS = 'kimi-for-coding'
const FAST_ALIAS = 'kimi-for-coding-highspeed'
const ALIAS_NAME = 'Kimi for Coding'
const FAST_NAME = 'Kimi For Coding Highspeed'
const KIMI_LABEL = 'Kimi account (device-code sign-in · global (kimi.ai))'
const PLAN_LIST = { object: 'list', data: [
  { id: FAST_ALIAS, object: 'model', created: 200, owned_by: 'moonshot', context_length: 262144 },
  { id: ALIAS, object: 'model', created: 100, owned_by: 'moonshot', context_length: 262144, display_name: ALIAS_NAME },
] }
const NESTED_LIST = { object: 'list', data: [
  { id: 'kimi-a-b-c', object: 'model', created: 400, owned_by: 'moonshot' },
  { id: 'kimi-a-b', object: 'model', created: 300, owned_by: 'moonshot' },
  { id: 'kimi-a', object: 'model', created: 200, owned_by: 'moonshot' },
  { id: 'kimi-z', object: 'model', created: 500, owned_by: 'moonshot' },
] }

type ListMode = { kind: 'hold' } | { kind: 'list'; body: unknown } | { kind: 'fail'; status: number }
let listMode: ListMode = { kind: 'hold' }
let listRequests = 0
let releaseHeld: (() => void) | null = null
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request) => {
  const spelled = String(url instanceof Request ? url.url : url)
  if (spelled === 'http://127.0.0.1:1/coding/v1/models') {
    listRequests++
    const mode = listMode
    if (mode.kind === 'fail') return Response.json({ error: { message: 'fixture down' } }, { status: mode.status })
    if (mode.kind === 'list') return Response.json(mode.body)
    return new Promise<Response>(resolve => {
      releaseHeld = () => resolve(Response.json(PLAN_LIST))
    })
  }
  if (spelled.includes('/v1/models')) {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fixture: no list here' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }
  throw new Error(`unexpected request: ${spelled}`)
}) as typeof fetch

;(await import('../../src/utils/config.ts')).enableConfigs()
const accounts = await import('../../src/services/providers/moonshot/moonshotAccounts.ts')
const catalogue = await import('../../src/services/providers/moonshot/moonshotCatalogue.ts')
const modelOptions = await import('../../src/utils/model/modelOptions.ts')
const { getModelOptions, keyLanePins, keyLaneGroupRows, keyConnectValue, isProviderActionRow, MOONSHOT_MODEL_GROUP } = modelOptions
const { KIMI_DISPLAY_PINS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { computedDefault, resetComputedDefaultMemo, readComputedDefaultCatalogue } = await import('../../src/utils/model/computedDefault.ts')
const { providerFrontierFact } = await import('../../src/utils/model/providerFrontier.ts')
const { resolveEngineDispatch } = await import('../../src/utils/swarm/engineDispatch.ts')
const { moonshotCatalogueEntries, describeMoonshotProvider, listMoonshotModels } = await import('../../src/utils/router/providers/moonshot.ts')
const { catalogueEpoch } = await import('../../src/services/providers/catalogueEpoch.ts')
const { readCatalogueIfPending } = await import('../../src/services/providers/catalogueOnDemand.ts')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.ts')

type ListState = { kind: string; reading?: boolean; error?: string; count?: number }
const listState = (): ListState | undefined => (modelOptions as { keyLaneListState?: (provider: 'moonshot') => ListState }).keyLaneListState?.('moonshot')
const PIN_IDS = KIMI_DISPLAY_PINS.map(pin => pin.id)
const moonshotRows = () => getModelOptions().filter(option => option.group === MOONSHOT_MODEL_GROUP)
const modelIdsOf = (rows: ReturnType<typeof getModelOptions>): string[] => rows.map(row => row.value).filter(value => !isProviderActionRow(value))
const pinIdsAnywhere = (): string[] => getModelOptions().map(row => row.value).filter(value => PIN_IDS.includes(value))
const moonshotVerdict = () => {
  resetComputedDefaultMemo()
  const decision = computedDefault()
  return { decision, considered: decision.considered.find(entry => entry.family === 'moonshot') }
}
const kimiWord = (): Promise<string> => resolveEngineDispatch('kimi').then(resolved => `resolved ${resolved?.model ?? 'null'}`, error => `threw ${error instanceof Error ? error.message : String(error)}`)
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 50))
const TOKENS = { accessToken: 'fixture-access-plan', refreshToken: 'fixture-refresh-plan', accessTokenExpiresAtMs: Date.now() + 86400000 }

section('§1 signed out: the built-in pin table previews the lineup and nothing is selectable')
{
  const preview = catalogue.moonshotCatalogueRows()
  check('the owner answers the pin rows with the pin source', preview.source.kind === 'pin' && preview.rows.map(row => row.id).join(',') === PIN_IDS.join(',') && preview.rows.every(row => !row.listedLive), JSON.stringify(preview.source))
  const rows = moonshotRows()
  check('the section leads with the sign-in action row and paints every pin unavailable', rows[0]?.value === keyConnectValue('moonshot') && modelIdsOf(rows).join(',') === PIN_IDS.join(',') && rows.slice(1).every(row => row.unavailable === 'no API key attached'), JSON.stringify(rows.map(row => [row.value, row.unavailable])))
  check('the list state reads pin', listState()?.kind === 'pin', JSON.stringify(listState()))
  check('no model list request was made while signed out', listRequests === 0)
  check('the default considers no Moonshot credential', !computedDefault().considered.some(entry => entry.family === 'moonshot'))
}

section('§2 signed in, before any read: one status row, no model id, an unusable default that says the list is not read')
{
  accounts.writeMoonshotTokens(TOKENS, 'global')
  recordSignIn('moonshot', 'oauth')
  const unread = catalogue.moonshotCatalogueRows()
  check('the owner lists nothing and says the list is unread and being read', unread.rows.length === 0 && unread.source.kind === 'unread' && (unread.source as { reading?: boolean }).reading === true && !('error' in unread.source), JSON.stringify(unread))
  check('the picker pins are empty', keyLanePins('moonshot').length === 0, JSON.stringify(keyLanePins('moonshot')))
  const rows = moonshotRows()
  check('the section paints exactly one status row: the action value, the reading words, selectable as an action only', rows.length === 1 && rows[0]?.value === keyConnectValue('moonshot') && rows[0].label === 'Moonshot — reading model list…' && rows[0].unavailable === undefined && rows[0].description.includes('↵ reads it again'), JSON.stringify(rows))
  check('no model id paints in the section and no pin id paints anywhere', modelIdsOf(rows).length === 0 && pinIdsAnywhere().length === 0, JSON.stringify(pinIdsAnywhere()))
  await flush()
  check('composing the picker kicked exactly one read of the account list, still in flight', listRequests === 1 && releaseHeld !== null && catalogue.moonshotCatalogueRows().source.kind === 'unread' && (catalogue.moonshotCatalogueRows().source as { reading?: boolean }).reading === true, `${listRequests} request(s)`)
  check('the list state reads unread, reading', listState()?.kind === 'unread' && listState()?.reading === true, JSON.stringify(listState()))
  const { decision, considered } = moonshotVerdict()
  check("the default is unusable with the not-read words and the decision falls through past the sign-in", considered?.verdict.usable === false && considered.verdict.why === "the account's model list has not been read" && decision.provider !== 'moonshot' && decision.source === 'fallthrough' && decision.considered[0]?.family === 'moonshot', JSON.stringify({ provider: decision.provider, source: decision.source, why: considered?.verdict.why }))
  check('the frontier fact is silent on an unread list', providerFrontierFact('moonshot') === undefined, JSON.stringify(providerFrontierFact('moonshot')))
  check('the adapter lists and describes nothing', listMoonshotModels().length === 0 && describeMoonshotProvider().catalogue.length === 0 && moonshotCatalogueEntries().length === 0)
}

section('§3 the list lands: exactly the account ids, the base alias first, truthful names, the default on the head')
{
  const epochBefore = catalogueEpoch()
  releaseHeld?.()
  const snapshot = await catalogue.refreshMoonshotCatalogue()
  check('the in-flight read landed the two account ids and bumped the epoch (the picker repaints in place)', snapshot !== null && snapshot.fetchedAtMs > 0 && snapshot.models.length === 2 && catalogueEpoch() > epochBefore, JSON.stringify(snapshot))
  const byCreated = snapshot!.models.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0)).map(model => model.id)
  check('the stamps alone would put the highspeed variant first', byCreated.join(',') === `${FAST_ALIAS},${ALIAS}`, byCreated.join(','))
  const live = catalogue.moonshotCatalogueRows()
  check('the owner lists exactly the account ids, the base alias before its variant', live.source.kind === 'live' && live.rows.map(row => row.id).join(',') === `${ALIAS},${FAST_ALIAS}` && live.rows.every(row => row.listedLive), live.rows.map(row => row.id).join(','))
  check("the names are truthful: the endpoint's own display_name, else the id's mechanical title, never a pin's generation", live.rows.find(row => row.id === ALIAS)?.displayName === ALIAS_NAME && live.rows.find(row => row.id === FAST_ALIAS)?.displayName === FAST_NAME && live.rows.every(row => !KIMI_DISPLAY_PINS.some(pin => pin.displayName === row.displayName)), live.rows.map(row => `${row.id}=${row.displayName}`).join(' | '))
  const rows = moonshotRows()
  check('the section paints exactly the two ids, both selectable, in the owner order, with the truthful labels', rows.length === 2 && modelIdsOf(rows).join(',') === `${ALIAS},${FAST_ALIAS}` && rows.every(row => row.unavailable === undefined) && rows.map(row => row.label).join(' | ') === `${ALIAS_NAME} | ${FAST_NAME}`, JSON.stringify(rows.map(row => [row.value, row.label, row.unavailable])))
  check('no status row and no pin id anywhere', !rows.some(row => isProviderActionRow(row.value)) && pinIdsAnywhere().length === 0)
  check('the list state reads live with the count', listState()?.kind === 'live' && listState()?.count === 2, JSON.stringify(listState()))
  const { decision } = moonshotVerdict()
  check('the default is the head of the live list: kimi-for-coding, named from the live catalogue', decision.provider === 'moonshot' && decision.setting === ALIAS && decision.row === ALIAS_NAME && decision.why.includes('the live catalogue'), JSON.stringify({ provider: decision.provider, setting: decision.setting, row: decision.row, why: decision.why }))
  check('the frontier fact names the head from the live source', providerFrontierFact('moonshot')?.modelId === ALIAS && providerFrontierFact('moonshot')?.source === '2 models live', JSON.stringify(providerFrontierFact('moonshot')))
  const requestsBefore = listRequests
  const word = await kimiWord()
  check("the 'kimi' family word resolves the head without another request", word === `resolved ${ALIAS}` && listRequests === requestsBefore, word)
  check('the adapter agrees: entries and models lead with the base alias, described as live discovery', moonshotCatalogueEntries()[0]?.id === ALIAS && listMoonshotModels()[0]?.ref.model === ALIAS && describeMoonshotProvider().catalogueSource === 'live-discovery')
}

section('§3a the order rule is deterministic across nested variants')
{
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'list', body: NESTED_LIST }
  await catalogue.refreshMoonshotCatalogue({ force: true })
  const ids = catalogue.moonshotCatalogueRows().rows.map(row => row.id).join(',')
  check('heads keep the stamp order; every variant follows its longest listed base, nested variants in turn', ids === 'kimi-z,kimi-a,kimi-a-b,kimi-a-b-c', ids)
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'list', body: PLAN_LIST }
  await catalogue.refreshMoonshotCatalogue({ force: true })
  check('the plan list reads the same order after a re-read', catalogue.moonshotCatalogueRows().rows.map(row => row.id).join(',') === `${ALIAS},${FAST_ALIAS}`)
}

section('§4 a failed read: the unavailable row names the error, no ids, the default and the family word say why')
{
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'fail', status: 503 }
  await catalogue.refreshMoonshotCatalogue({ force: true })
  const failed = catalogue.moonshotCatalogueRows()
  const error = 'Moonshot models endpoint returned HTTP 503'
  check('the owner lists nothing and says the list is unread with the error, not being read', failed.rows.length === 0 && failed.source.kind === 'unread' && (failed.source as { reading?: boolean }).reading === false && (failed.source as { error?: string }).error === error, JSON.stringify(failed))
  const requestsBefore = listRequests
  const rows = moonshotRows()
  check('the section paints one unavailable status row naming the error, with the retry words, and no model id', rows.length === 1 && rows[0]?.value === keyConnectValue('moonshot') && rows[0].label === 'Moonshot — list unavailable' && rows[0].unavailable === `model list unavailable — ${error}` && rows[0].description === `model list unavailable: ${error} — ↵ retries now` && modelIdsOf(rows).length === 0 && pinIdsAnywhere().length === 0, JSON.stringify(rows))
  check('composing the picker inside the failure window makes no new request', listRequests === requestsBefore)
  const { decision, considered } = moonshotVerdict()
  check('the default is unusable, naming the unread list and its error', considered?.verdict.usable === false && considered.verdict.why === `the account's model list has not been read (${error})` && decision.provider !== 'moonshot', JSON.stringify({ provider: decision.provider, why: considered?.verdict.why }))
  check('the frontier fact is silent', providerFrontierFact('moonshot') === undefined)
  const word = await kimiWord()
  check("the 'kimi' family word throws a plain message naming the account and the reason", word === `threw The 'kimi' class cannot resolve — the ${KIMI_LABEL}'s model list has not been read (${error}). Name an exact kimi-… id the account serves, or retry when the list lands.`, word)
  const admission = await catalogue.qualifyMoonshotModel(ALIAS)
  check('an exact id still dispatches on the degraded road (the provider validates it) — the section, not the dispatch, is what changed', admission.kind === 'degraded' && admission.note.includes(error), JSON.stringify(admission))
}

section('§4a traffic switched off: the row says so and no request is made')
{
  catalogue.__resetMoonshotCatalogueForTest()
  process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  const requestsBefore = listRequests
  const dark = catalogue.moonshotCatalogueRows()
  const rows = moonshotRows()
  check("the owner says the list is unread with the traffic gate's own reason, not being read", dark.rows.length === 0 && dark.source.kind === 'unread' && (dark.source as { reading?: boolean }).reading === false && ((dark.source as { error?: string }).error ?? '').startsWith('catalogue traffic is off'), JSON.stringify(dark.source))
  check('the section paints the unavailable status row with that reason and makes no request', rows.length === 1 && rows[0]?.label === 'Moonshot — list unavailable' && (rows[0].unavailable ?? '').includes('catalogue traffic is off') && listRequests === requestsBefore, JSON.stringify(rows))
  delete process.env.MERCURY_DISABLE_NONESSENTIAL_TRAFFIC
}

section('§5 the boot road: the on-demand read lands the list for the most recent sign-in, and the default follows')
{
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'list', body: PLAN_LIST }
  const requestsBefore = listRequests
  const read = await readCatalogueIfPending('moonshot')
  check('the on-demand reader reads a signed-in family with nothing cached, once', read === true && listRequests === requestsBefore + 1 && catalogue.moonshotCatalogueRows().source.kind === 'live')
  check('a second ask reads nothing (the rows are cached)', (await readCatalogueIfPending('moonshot')) === false && listRequests === requestsBefore + 1)
  catalogue.__resetMoonshotCatalogueForTest()
  await readComputedDefaultCatalogue()
  const { decision } = moonshotVerdict()
  check('the boot boundary reads the most recent sign-in\'s list and the default lands on its head', listRequests === requestsBefore + 2 && decision.provider === 'moonshot' && decision.setting === ALIAS, JSON.stringify({ provider: decision.provider, setting: decision.setting, requests: listRequests - requestsBefore }))
}

section('§6 the pure composer: the status row grammar over injected states')
{
  const base = { group: MOONSHOT_MODEL_GROUP, providerName: 'Moonshot', connectValue: keyConnectValue('moonshot'), connectHint: 'hint', keyPresent: true, pins: [] as never[] }
  type Composer = (args: typeof base & { listState?: ListState }) => ReturnType<typeof keyLaneGroupRows>
  const compose = keyLaneGroupRows as unknown as Composer
  const reading = compose({ ...base, listState: { kind: 'unread', reading: true } })
  check('unread + reading ⇒ one action row, not unavailable', reading.length === 1 && reading[0]?.value === keyConnectValue('moonshot') && reading[0].unavailable === undefined && reading[0].label === 'Moonshot — reading model list…', JSON.stringify(reading))
  const failed = compose({ ...base, listState: { kind: 'unread', reading: false, error: 'boom' } })
  check('unread + failed ⇒ one unavailable row carrying the error', failed.length === 1 && failed[0]?.unavailable === 'model list unavailable — boom' && failed[0].description === 'model list unavailable: boom — ↵ retries now', JSON.stringify(failed))
  check('a live empty list ⇒ no row (an authoritative empty answer), and no list state ⇒ no row (the other key lanes as they were)', compose({ ...base, listState: { kind: 'live', count: 0 } }).length === 0 && compose({ ...base }).length === 0)
  check('signed out ⇒ the attach row and the pins unavailable, whatever the list state', compose({ ...base, keyPresent: false, pins: [{ id: 'kimi-x', displayName: 'Kimi X', observedAt: '2026-08-21' }] as never[], listState: { kind: 'unread', reading: true } }).map(row => row.unavailable ?? 'action').join(',') === 'action,no API key attached')
}

section('§7 the seams, source-shaped: one three-state owner, every reader follows')
{
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8')
  const owner = src('services/providers/moonshot/moonshotCatalogue.ts')
  check('the owner gates the pin table on the absence of an account, then the fetched snapshot, else an unread source', owner.includes('if (resolveMoonshotAccount(env) === undefined) {') && owner.includes("kind: 'unread'; reading: boolean; error?: string") && owner.includes('return { rows: [], source: unreadSource(snapshot, env) }'))
  check('the owner orders the base alias before its variants', owner.includes('return { rows: baseAliasLeads(rows), source:'))
  const options = src('utils/model/modelOptions.ts')
  check('the picker row source reads the list state beside the pins and paints the status row from it', options.includes("listState: keyLaneListState('moonshot')") && options.includes("args.listState?.kind === 'unread'") && options.includes('kickMoonshotCatalogue()'))
  const defaults = src('utils/model/computedDefault.ts')
  check('the default reads the list state and says the list has not been read', defaults.includes('keyLaneListState(family)') && defaults.includes("the account's model list has not been read"))
  check("the 'kimi' family word names the account and the unread list", src('utils/swarm/engineDispatch.ts').includes("model list has not been read"))
  const picker = src('commands/model/mercuryModel.tsx')
  check('↵ on the Moonshot status row re-reads the list in place for a signed-in account; a signed-out row still runs /logins', picker.includes("refreshMoonshotCatalogue({ force: true })") && picker.includes("nextInput: '/logins moonshot --return=/model'") && picker.includes('useCatalogueEpoch()'))
  const onDemand = src('services/providers/catalogueOnDemand.ts')
  check('the boot road reads the Moonshot list when nothing usable is cached, bounded', onDemand.includes("case 'moonshot'") && onDemand.includes('nothingUsable(getCachedMoonshotCatalogue())') && onDemand.includes('await bounded(refreshMoonshotCatalogue({ force }), boundMs)'))
}

globalThis.fetch = realFetch
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-moonshot-plan-picker: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
