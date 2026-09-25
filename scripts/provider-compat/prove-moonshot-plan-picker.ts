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
const chatBodies: Array<Record<string, unknown>> = []
const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
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
  if (spelled === 'http://127.0.0.1:1/coding/v1/chat/completions') {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    chatBodies.push(body)
    const model = String(body.model ?? '')
    return new Response(
      sse({ id: 'chatcmpl-plan', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'plan answer' } }] }) +
        sse({ id: 'chatcmpl-plan', object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }) +
        'data: [DONE]\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
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
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const engine = await import('../../src/utils/swarm/engineDispatch.ts')
const { getContextWindowForModel, effortVocabularyFor } = await import('../../src/utils/model/capabilities.ts')
const { moonshotCallModel } = await import('../../src/services/providers/moonshot/moonshotCallModel.ts')
const { routedCallModel } = await import('../../src/services/providers/callModelRouter.ts')
const { createUserMessage } = await import('../../src/utils/messages.ts')
const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')

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
  check('the owner orders the base alias before its variants', owner.includes('return { rows: baseAliasLeads(planHeadLeads(rows)), source:'))
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

const K3 = 'k3'
const K3_256K = 'k3-256k'
const liveIds = (): ReadonlySet<string> => (catalogue as { cachedLiveIds?: () => ReadonlySet<string> }).cachedLiveIds?.() ?? new Set()
const CODING_PLAN_LIST = { object: 'list', data: [
  { id: FAST_ALIAS, object: 'model', created: 400, owned_by: 'moonshot', context_length: 262144 },
  { id: ALIAS, object: 'model', created: 300, owned_by: 'moonshot', context_length: 262144, display_name: ALIAS_NAME },
  { id: K3_256K, object: 'model', created: 200, owned_by: 'moonshot' },
  { id: K3, object: 'model', created: 100, owned_by: 'moonshot' },
] }
const chatParams = (model: string): Parameters<typeof moonshotCallModel>[0] => ({
  messages: [createUserMessage({ content: 'say hi' })],
  systemPrompt: ['fixture system prompt'],
  thinkingConfig: { type: 'disabled' },
  tools: [],
  signal: new AbortController().signal,
  options: { getToolPermissionContext: async () => getEmptyToolPermissionContext(), model, isNonInteractiveSession: true, querySource: 'agent:builtin:test', agents: [], hasAppendSystemPrompt: false, mcpTools: [], effortValue: 'high' },
}) as never
type Settled = { model: string; api: boolean; text: string }
async function turn(model: string): Promise<Settled[]> {
  const out: Settled[] = []
  for await (const item of moonshotCallModel(chatParams(model))) {
    if ((item as { type?: string }).type !== 'assistant') continue
    const message = item as { isApiErrorMessage?: boolean; message: { model: string; content: Array<{ type: string; text?: string }> } }
    out.push({ model: message.message.model, api: message.isApiErrorMessage === true, text: message.message.content.map(block => block.text ?? '').join('') })
  }
  return out
}

section('§8 the coding plan serves k3: an off-grammar id that arrived in the account\'s list belongs to Moonshot, paints as K3, leads, and dispatches')
{
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'list', body: CODING_PLAN_LIST }
  const snapshot = await catalogue.refreshMoonshotCatalogue({ force: true })
  const byCreated = (snapshot?.models ?? []).toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0)).map(model => model.id)
  check('the list lands whole — four ids, the two off-grammar ones kept — and the stamps alone would put the highspeed variant first', snapshot !== null && snapshot.models.length === 4 && byCreated.join(',') === `${FAST_ALIAS},${ALIAS},${K3_256K},${K3}`, byCreated.join(','))
  const live = catalogue.moonshotCatalogueRows()
  check('the rows run k3 · k3-256k · kimi-for-coding · kimi-for-coding-highspeed', live.source.kind === 'live' && live.rows.map(row => row.id).join(',') === `${K3},${K3_256K},${ALIAS},${FAST_ALIAS}`, live.rows.map(row => row.id).join(','))
  check('k3 paints as K3 with its 1,048,576 context and k3-256k as K3 256K with 262,144 — from the plan table, the list stating no window', live.rows[0]?.displayName === 'K3' && live.rows[0].contextWindow === 1_048_576 && live.rows[1]?.displayName === 'K3 256K' && live.rows[1].contextWindow === 262_144, JSON.stringify(live.rows.map(row => [row.id, row.displayName, row.contextWindow])))
  check("the alias rows keep their names: the endpoint's display_name and the mechanical title", live.rows[2]?.displayName === ALIAS_NAME && live.rows[3]?.displayName === FAST_NAME)
  const rows = moonshotRows()
  check('the section paints the four rows in that order, every one selectable, K3 first', modelIdsOf(rows).join(',') === `${K3},${K3_256K},${ALIAS},${FAST_ALIAS}` && rows.every(row => row.unavailable === undefined) && rows[0]?.label === 'K3' && rows[0].statedContextWindow === 1_048_576 && rows[1]?.label === 'K3 256K' && rows[1].statedContextWindow === 262_144, JSON.stringify(rows.map(row => [row.value, row.label, row.statedContextWindow, row.unavailable])))
  check('the signed-in account lists k3 among its live ids', liveIds().has(K3) && liveIds().has(K3_256K) && liveIds().has(ALIAS) && !liveIds().has('kimi-k3'), [...liveIds()].join(','))
  check("declaredRouteOf('k3') is moonshot on this account — by provenance, not by prefix", declaredRouteOf(K3) === 'moonshot' && declaredRouteOf(K3_256K) === 'moonshot' && declaredRouteOf('K3[1m]') === 'moonshot', String(declaredRouteOf(K3)))
  check("isExactEngineModelId('k3') on this account", engine.isExactEngineModelId(K3) && engine.isExactEngineModelId(K3_256K) && engine.unrecognisedModelWordRefusal(K3) === null)
  const { decision } = moonshotVerdict()
  check('the default is k3 (keyLaneRow): the head of the live list, named K3', decision.provider === 'moonshot' && decision.setting === K3 && decision.row === 'K3', JSON.stringify({ provider: decision.provider, setting: decision.setting, row: decision.row }))
  check('the frontier fact names k3 from the live source', providerFrontierFact('moonshot')?.modelId === K3 && providerFrontierFact('moonshot')?.displayName === 'K3', JSON.stringify(providerFrontierFact('moonshot')))
  check("the 'kimi' class resolves k3", (await kimiWord()) === `resolved ${K3}`)
  const exact = await engine.resolveEngineDispatch(K3)
  check("the exact-id road resolves --model k3 to Moonshot's k3, labelled K3", exact?.backend === 'moonshot' && exact.model === K3 && exact.displayLabel === 'K3', JSON.stringify(exact))
  check('the K3 laws read k3 and k3-256k as the K3 model: the effort dial, the context budget', effortVocabularyFor(K3).kind === 'provider' && effortVocabularyFor(K3_256K).kind === 'provider' && getContextWindowForModel(K3) === 1_048_576 && getContextWindowForModel(K3_256K) === 262_144, JSON.stringify({ k3: effortVocabularyFor(K3), window: getContextWindowForModel(K3), window256: getContextWindowForModel(K3_256K) }))
  const typed = await catalogue.qualifyMoonshotModel('kimi-k3')
  check("a typed kimi-k3 on the plan account qualifies to k3 (the list lacks kimi-k3 and holds k3)", typed.kind === 'ok' && typed.modelId === K3, JSON.stringify(typed))
  check("the general form: kimi-k3-256k → k3-256k; kimi-for-coding stays itself; a kimi-<x> with no listed <x> is refused", (await catalogue.qualifyMoonshotModel('kimi-k3-256k')).kind === 'ok' && (await catalogue.qualifyMoonshotModel('kimi-k3-256k') as { modelId?: string }).modelId === K3_256K && (await catalogue.qualifyMoonshotModel(ALIAS) as { modelId?: string }).modelId === ALIAS && (await catalogue.qualifyMoonshotModel('kimi-k2.6')).kind === 'refused')
  const typedDispatch = await engine.resolveEngineDispatch('kimi-k3')
  check("the exact-id road maps --model kimi-k3 to k3 on this account", typedDispatch?.backend === 'moonshot' && typedDispatch.model === K3 && typedDispatch.displayLabel === 'K3', JSON.stringify(typedDispatch))
  chatBodies.length = 0
  const settled = await turn('kimi-k3')
  check('a dispatch typed kimi-k3 puts model "k3" on the wire and settles clean', chatBodies.length === 1 && chatBodies[0]?.model === K3 && settled.some(item => item.text === 'plan answer') && settled.every(item => !item.api), JSON.stringify({ bodies: chatBodies.map(body => body.model), settled }))
  check('the wire carried the K3 effort word for the mapped id (the laws are the model\'s, not the spelling\'s)', chatBodies[0]?.reasoning_effort === 'high', JSON.stringify(chatBodies[0]))
  chatBodies.length = 0
  catalogue.__resetMoonshotCatalogueForTest()
  const requestsBefore = listRequests
  check("with the list not yet read in this process, 'k3' is unrecognised by the sync classifier", declaredRouteOf(K3) === null)
  const routed: Settled[] = []
  for await (const item of routedCallModel(chatParams(K3) as never)) {
    if ((item as { type?: string }).type !== 'assistant') continue
    const message = item as { isApiErrorMessage?: boolean; message: { model: string; content: Array<{ type: string; text?: string }> } }
    routed.push({ model: message.message.model, api: message.isApiErrorMessage === true, text: message.message.content.map(block => block.text ?? '').join('') })
  }
  check('the dispatch road reads the account lists for an unrecognised bare id, then routes k3 to Moonshot and puts k3 on the wire', listRequests === requestsBefore + 1 && chatBodies.length === 1 && chatBodies[0]?.model === K3 && routed.some(item => item.text === 'plan answer') && routed.every(item => !item.api), JSON.stringify({ requests: listRequests - requestsBefore, bodies: chatBodies.map(body => body.model), routed }))
  check("after that read the classifier routes 'k3' to moonshot again", declaredRouteOf(K3) === 'moonshot')
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'list', body: { object: 'list', data: CODING_PLAN_LIST.data.filter(model => model.id !== K3) } }
  await catalogue.refreshMoonshotCatalogue({ force: true })
  const without = moonshotVerdict().decision
  check('a list without k3 leads with k3-256k and defaults to it', catalogue.moonshotCatalogueRows().rows[0]?.id === K3_256K && without.setting === K3_256K && (await kimiWord()) === `resolved ${K3_256K}`, JSON.stringify({ head: catalogue.moonshotCatalogueRows().rows[0]?.id, setting: without.setting }))
  check("a typed kimi-k3 on that list is refused (no k3 listed), naming the offered ids", (await catalogue.qualifyMoonshotModel('kimi-k3')).kind === 'refused')
  accounts.writeMoonshotTokens(null)
  catalogue.__resetMoonshotCatalogueForTest()
  check("signed out, 'k3' routes nowhere by grammar while 'kimi-k3' still routes to moonshot by grammar", declaredRouteOf(K3) === null && declaredRouteOf('kimi-k3') === 'moonshot' && !engine.isExactEngineModelId(K3) && engine.isExactEngineModelId('kimi-k3') && liveIds().size === 0, `${String(declaredRouteOf(K3))} / ${String(declaredRouteOf('kimi-k3'))}`)
}

section('§9 a real Kimi sign-in: the access token lives fifteen minutes and rotates on refresh, and the list stays under the account')
{
  const SUBJECT = 'fixture-subject-plan'
  const LIFETIME_S = 15 * 60
  let minted = 0
  const jwt = (issuedAtS: number): string => {
    minted++
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: SUBJECT, user_id: SUBJECT, iat: issuedAtS, exp: issuedAtS + LIFETIME_S, jti: `jti-${minted}` })}.sig`
  }
  const refreshPosts: string[] = []
  const tokenFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const spelled = String(url instanceof Request ? url.url : url)
    if (spelled === 'http://127.0.0.1:1/api/oauth/token') {
      refreshPosts.push(String(new URLSearchParams(String(init?.body ?? '')).get('refresh_token')))
      const nowS = Math.floor(Date.now() / 1000)
      return Response.json({ access_token: jwt(nowS), refresh_token: `fixture-refresh-rotated-${refreshPosts.length}`, expires_in: LIFETIME_S })
    }
    return tokenFetch(url, init)
  }) as typeof fetch
  const nowS = Math.floor(Date.now() / 1000)
  const tenMinutesLeft = { accessToken: jwt(nowS - 5 * 60), refreshToken: 'fixture-refresh-live', accessTokenExpiresAtMs: (nowS + 10 * 60) * 1000 }
  accounts.writeMoonshotTokens(tenMinutesLeft, 'global')
  recordSignIn('moonshot', 'oauth')
  catalogue.__resetMoonshotCatalogueForTest()
  listMode = { kind: 'list', body: CODING_PLAN_LIST }
  const marginOf = (accounts as { accessTokenRefreshMarginMs?: (tokens: typeof tenMinutesLeft) => number }).accessTokenRefreshMarginMs
  check('the refresh margin follows the token lifetime: a fifteen-minute token refreshes inside its last five minutes, never on every request', marginOf?.(tenMinutesLeft) === 5 * 60 * 1000, String(marginOf?.(tenMinutesLeft)))
  await catalogue.refreshMoonshotCatalogue({ force: true })
  check('a catalogue read on a token with ten minutes left posts no refresh grant', refreshPosts.length === 0, JSON.stringify(refreshPosts))
  const landed = catalogue.moonshotCatalogueRows()
  check('the list landed under the account and the section paints the plan, k3 first', landed.source.kind === 'live' && landed.rows.map(row => row.id).join(',') === `${K3},${K3_256K},${ALIAS},${FAST_ALIAS}`, JSON.stringify(landed.source) + ' ' + landed.rows.map(row => row.id).join(','))
  check('k3 carries the plan window over the endpoint, k3-256k its own', landed.rows[0]?.contextWindow === 1_048_576 && landed.rows[1]?.contextWindow === 262_144, JSON.stringify(landed.rows.map(row => [row.id, row.contextWindow])))
  const threeMinutesLeft = { accessToken: jwt(nowS - 12 * 60), refreshToken: 'fixture-refresh-live', accessTokenExpiresAtMs: (nowS + 3 * 60) * 1000 }
  accounts.writeMoonshotTokens(threeMinutesLeft, 'global')
  check('a token rotation by another road (the same account) keeps the list: the section still paints it', catalogue.moonshotCatalogueRows().source.kind === 'live' && catalogue.getCachedMoonshotCatalogue() !== null && catalogue.cachedLiveIds().has(K3), JSON.stringify(catalogue.moonshotCatalogueRows().source))
  await catalogue.refreshMoonshotCatalogue({ force: true })
  check('a read on a token inside its last five minutes refreshes it once, through the refresh grant', refreshPosts.length === 1 && refreshPosts[0] === 'fixture-refresh-live', JSON.stringify(refreshPosts))
  const rotated = accounts.moonshotStoredTokens()
  const keyOf = (accounts as { kimiAccountKey?: (tokens: typeof tenMinutesLeft) => string }).kimiAccountKey
  check('the rotated token is stored (a new access token, a new refresh token) and the account key does not move', rotated !== undefined && rotated.accessToken !== threeMinutesLeft.accessToken && rotated.refreshToken === 'fixture-refresh-rotated-1' && keyOf?.(rotated) === keyOf?.(threeMinutesLeft), JSON.stringify({ key: rotated && keyOf ? keyOf(rotated) : null }))
  const afterRotation = catalogue.moonshotCatalogueRows()
  check('the list read with the rotated token in hand is stored where the next read finds it: live rows, k3 first', afterRotation.source.kind === 'live' && afterRotation.rows[0]?.id === K3 && catalogue.cachedLiveIds().has(K3), JSON.stringify(afterRotation.source))
  for (let round = 0; round < 3; round++) {
    accounts.writeMoonshotTokens({ accessToken: jwt(Math.floor(Date.now() / 1000)), refreshToken: `fixture-refresh-live-${round}`, accessTokenExpiresAtMs: Date.now() + LIFETIME_S * 1000 }, 'global')
    check(`rotation ${round + 1}: the picker still paints the plan's rows and the seam still routes k3 to Moonshot`, moonshotRows().some(row => row.value === K3) && catalogue.moonshotCatalogueRows().source.kind === 'live' && declaredRouteOf(K3) === 'moonshot', JSON.stringify(catalogue.moonshotCatalogueRows().source))
  }
  const other = { accessToken: (() => { const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); return `${encode({ alg: 'none' })}.${encode({ sub: 'fixture-subject-other', iat: nowS, exp: nowS + LIFETIME_S })}.sig` })(), refreshToken: 'fixture-refresh-other', accessTokenExpiresAtMs: Date.now() + LIFETIME_S * 1000 }
  accounts.writeMoonshotTokens(other, 'global')
  recordSignIn('moonshot', 'oauth')
  check("another account's sign-in does not inherit the list: its own read is pending", catalogue.moonshotCatalogueRows().source.kind === 'unread' && !catalogue.cachedLiveIds().has(K3), JSON.stringify(catalogue.moonshotCatalogueRows().source))
  const owner = readFileSync(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotCatalogue.ts'), 'utf8')
  const accountsSrc = readFileSync(join(import.meta.dir, '../../src/services/providers/moonshot/moonshotAccounts.ts'), 'utf8')
  check('the catalogue identity of a Kimi sign-in is the account key, never the access token', owner.includes('return `kimi-oauth:${tokens ? kimiAccountKey(tokens) : \'\'}:${kimiCodingBase(account.region, env)}`') && !owner.includes('credentialFingerprint(moonshotStoredTokens()?.accessToken'))
  check('the read stores the list under the same identity it is read by', owner.includes("destination = source === 'kimi-oauth' ? catalogueIdentity(env) : "))
  check('the refresh margin is derived from the token lifetime', accountsSrc.includes('expiresAt - now < accessTokenRefreshMarginMs(oauth)') && accountsSrc.includes('Math.floor((expiresAt - issuedAt) / 3)'))
  globalThis.fetch = tokenFetch
  accounts.writeMoonshotTokens(null)
  catalogue.__resetMoonshotCatalogueForTest()
}

globalThis.fetch = realFetch
rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-moonshot-plan-picker: ${checks} checks, ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
