#!/usr/bin/env bun
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openai-live-provenance-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(join(import.meta.dir, '..', '..'))
for (const key of [
  'OPENAI_API_KEY',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_MODEL',
  'DEEPSEEK_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
  'HF_TOKEN',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
]) {
  delete process.env[key]
}
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:1'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'

const ROOT = join(import.meta.dir, '..', '..')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const { GPT_DISPLAY_PINS } = catalogue
const { getModelOptions, OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')
const { providerFrontierFact, providerLightFact, providerSmallFastFact } = await import('../../src/utils/model/providerFrontier.js')
const router = await import('../../src/utils/router/providers/openai.js')
const { computedDefault, resetComputedDefaultMemo } = await import('../../src/utils/model/computedDefault.js')
const { recordSignIn } = await import('../../src/utils/accounts/signInLedger.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

type LiveIds = (env?: NodeJS.ProcessEnv) => ReadonlySet<string>
const liveIds = (catalogue as { cachedLiveIds?: LiveIds }).cachedLiveIds
const ids = (): string[] => (liveIds ? [...liveIds()].sort() : ['<cachedLiveIds absent>'])

const SOL = 'gpt-5.6-sol'
const OFF = 'sol-6'
const HIDDEN = 'quiet-7'
type LiveRow = Record<string, unknown>
const LIST: LiveRow[] = [
  { id: OFF, display_name: 'Sol 6', visibility: 'list', priority: 1, supported_reasoning_levels: ['low', 'medium', 'high'], default_reasoning_level: 'medium', context_window: 400_000 },
  { id: SOL, display_name: 'GPT-5.6 Sol', visibility: 'list', priority: 2, supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'], default_reasoning_level: 'low', context_window: 272_000 },
  { id: HIDDEN, display_name: 'Quiet 7', visibility: 'hide', priority: 3, supported_reasoning_levels: ['low'] },
]
const fetchOf = (models: LiveRow[]): typeof fetch =>
  (async () => new Response(JSON.stringify({ data: models }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
const statusFetch = (status: number): typeof fetch =>
  (async () => new Response(JSON.stringify({ error: { message: `fixture ${status}` } }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

section('§1 a typed off-grammar id with no list to check keeps the grammar\'s answer')
{
  process.env.OPENAI_API_KEY = 'prover-key'
  catalogue.__resetOpenaiCatalogueForTest()
  check('the catalogue exports cachedLiveIds', typeof liveIds === 'function')
  check('no list fetched: cachedLiveIds is empty', ids().length === 0, ids().join(','))
  const typed = catalogue.evaluateGptCandidate(OFF, 'api-key')
  check("typed 'sol-6' with the list absent is 'not-gpt-family' as before", !typed.ok && typed.why.reason === 'not-gpt-family', JSON.stringify(typed))
  const grammar = catalogue.evaluateGptCandidate(SOL, 'api-key')
  check('a grammar id with the list absent is catalogue-unavailable as before', !grammar.ok && grammar.why.reason === 'catalogue-unavailable', JSON.stringify(grammar))
  const spelt = catalogue.evaluateGptCandidate('gpt-sol-6-nova-x', 'api-key')
  check("a gpt-spelt id the grammar cannot parse, with no list, stays 'unparseable-id'", !spelt.ok && spelt.why.reason === 'unparseable-id', JSON.stringify(spelt))
}

section('§2 the account\'s list holds the off-grammar id: it qualifies, paints and routes by provenance')
{
  catalogue.__resetOpenaiCatalogueForTest()
  const snapshot = await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fetchOf(LIST) })
  check('the list lands with its three rows', snapshot?.models.length === 3 && snapshot.fetchedAtMs > 0 && snapshot.lastError === undefined, JSON.stringify(snapshot))
  check(`cachedLiveIds() = every listed id, the hidden one included (routing is provenance; qualification refuses it)`, ids().join(',') === [SOL, HIDDEN, OFF].sort().join(','), ids().join(','))
  check('the set is memoised per snapshot', liveIds !== undefined && liveIds() === liveIds())

  const off = catalogue.evaluateGptCandidate(OFF, 'api-key')
  check("'sol-6' qualifies: served, visible, efforts decode", off.ok, JSON.stringify(off))
  check('its identity is minimal and honest: the id itself, the gpt family, unparsed, no invented generation', off.ok && off.candidate.identity.canonicalId === OFF && off.candidate.identity.family === 'gpt' && off.candidate.identity.unparsed === true && !('major' in off.candidate.identity) && !('minor' in off.candidate.identity), JSON.stringify(off.ok ? off.candidate.identity : off))
  check('it wears the live display name and carries no pin', off.ok && off.candidate.displayName === 'Sol 6' && off.candidate.pin === undefined)
  check('its live row rides the candidate (window, efforts, default)', off.ok && off.candidate.live.contextWindow === 400_000 && off.candidate.live.supportedReasoningEfforts.join(',') === 'low,medium,high' && off.candidate.live.defaultReasoningEffort === 'medium')
  const dressed = catalogue.evaluateGptCandidate(`${OFF}[served]`, 'api-key')
  check('the served-window dressing is stripped before the list is checked', dressed.ok && dressed.candidate.identity.canonicalId === OFF)
  const sol = catalogue.evaluateGptCandidate(SOL, 'api-key')
  check('the grammar row still parses (major 5 · minor 6) and is not unparsed', sol.ok && !sol.candidate.identity.unparsed && 'major' in sol.candidate.identity && sol.candidate.identity.major === 5 && sol.candidate.identity.minor === 6)

  const qualified = catalogue.qualifiedGptCandidates('primary', 'api-key').map(c => c.identity.canonicalId)
  check('the qualified list holds both, the parsed row FIRST although the off-grammar row carries the top live priority', qualified.join(',') === `${SOL},${OFF}`, qualified.join(','))
  const availability = catalogue.getGptSeatAvailability()
  check('the seat availability is ready with the same order', availability.state === 'ready' && availability.ids.join(',') === `${SOL},${OFF}`, JSON.stringify(availability))

  const hidden = catalogue.evaluateGptCandidate(HIDDEN, 'api-key')
  check("a hidden off-grammar listed id is refused by the FAMILY's own law ('hidden-or-retired'), never as not-gpt-family", !hidden.ok && hidden.why.reason === 'hidden-or-retired', JSON.stringify(hidden))
  const unlisted = catalogue.evaluateGptCandidate('luna-7', 'api-key')
  check("an off-grammar id the list does not hold stays 'not-gpt-family'", !unlisted.ok && unlisted.why.reason === 'not-gpt-family', JSON.stringify(unlisted))
  const unserved = catalogue.evaluateGptCandidate('gpt-9-zeta', 'api-key')
  check("a grammar id the list does not hold stays 'not-in-live-catalogue'", !unserved.ok && unserved.why.reason === 'not-in-live-catalogue', JSON.stringify(unserved))

  const options = getModelOptions()
  const openai = options.filter(o => o.group === OPENAI_MODEL_GROUP)
  const offRow = openai.find(o => o.value === OFF)
  check("the picker paints 'sol-6' in the OpenAI section under its live display name, selectable", offRow !== undefined && offRow.label === 'Sol 6' && offRow.unavailable === undefined && (offRow.descriptionForModel ?? '').startsWith(`Sol 6 (${OFF})`), JSON.stringify(offRow))
  const solIndex = openai.findIndex(o => o.value === SOL)
  const offIndex = openai.findIndex(o => o.value === OFF)
  check('the parsed row stands above it', solIndex >= 0 && offIndex > solIndex, `${solIndex} vs ${offIndex}`)
  check('the hidden id paints no row at all', !openai.some(o => o.value === HIDDEN))
  check('the unserved pins still paint visible-but-unavailable with the resolver\'s reason', GPT_DISPLAY_PINS.filter(p => p.id !== SOL).every(p => { const row = openai.find(o => o.value === p.id); return row !== undefined && typeof row.unavailable === 'string' && row.unavailable.includes('not served by the connected') }))

  const frontier = providerFrontierFact('openai')
  check('the frontier fact ranks the dated pins by the grammar and never names the unparsed row', frontier !== undefined && frontier.modelId !== OFF && frontier.modelId === 'gpt-6-astra', JSON.stringify(frontier))
  check('the light fact never names the unparsed row', providerLightFact('openai')?.modelId !== OFF, JSON.stringify(providerLightFact('openai')))
  const small = providerSmallFastFact('openai')
  check('the small-fast fact prices from the served parsed rows and never names the unparsed row', small?.modelId === SOL, JSON.stringify(small))

  check("the live-row readers answer the off-grammar id: window 400,000, the stated vocabulary, the listed words", catalogue.liveGptContextWindow(OFF) === 400_000 && JSON.stringify(catalogue.liveGptEffortCatalogue(OFF)) === JSON.stringify({ vocabulary: ['low', 'medium', 'high'], stated: true, defaultEffort: 'medium' }) && JSON.stringify(catalogue.liveGptListedEffortWords(OFF)) === JSON.stringify(['low', 'medium', 'high']), JSON.stringify([catalogue.liveGptContextWindow(OFF), catalogue.liveGptEffortCatalogue(OFF), catalogue.liveGptListedEffortWords(OFF)]))
  check('an id no cached list holds still answers undefined with no row (the zero-IO gate for strangers)', catalogue.liveGptContextWindow('luna-7') === undefined && catalogue.liveGptListedEffortWords('claude-opus-5') === undefined)

  const described = router.describeOpenaiProvider()
  const entry = described.catalogue.find(e => e.id === OFF)
  check('the router adapter lists it live with its own efforts and window', described.catalogueSource === 'live-discovery' && entry !== undefined && entry.displayLabel === 'Sol 6' && entry.efforts.join(',') === 'low,medium,high' && entry.contextWindow === 400_000, JSON.stringify(described.catalogue.map(e => e.id)))
  check('the seat listing carries it', router.listOpenaiModels().some(m => m.ref.model === OFF))
  const head = router.resolveOpenaiModel('gpt', 'balanced' as never)
  check("the 'gpt' class resolves to the parsed head, not the top-priority unparsed row", head?.model === SOL, JSON.stringify(head))

  check('the sign-in ledger records the key sign-in', recordSignIn('openai', 'api-key'))
  resetComputedDefaultMemo()
  const decision = computedDefault()
  check("the computed default stays 'gpt-5.6-sol' (the first row this sign-in can use)", decision.setting === SOL && decision.provider === 'openai', JSON.stringify({ setting: decision.setting, provider: decision.provider, why: decision.why }))
}

section('§3 signed out, a failed read, a stale list')
{
  delete process.env.OPENAI_API_KEY
  check('signed out: no account, cachedLiveIds is empty', ids().length === 0 && catalogue.getGptSeatAvailability().state === 'disabled', ids().join(','))
  process.env.OPENAI_API_KEY = 'prover-key'
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: statusFetch(503) })
  check('a failed first read: no rows, an error, nothing live', ids().length === 0 && (catalogue.getCachedOpenaiCatalogue('api-key')?.lastError ?? '').includes('503'), ids().join(','))
  const typed = catalogue.evaluateGptCandidate(OFF, 'api-key')
  check("with no list landed the typed off-grammar id is still 'not-gpt-family'", !typed.ok && typed.why.reason === 'not-gpt-family', JSON.stringify(typed))
  catalogue.__resetOpenaiCatalogueForTest()
  let t = 7_000_000
  const now = () => t
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fetchOf(LIST), now })
  t += 1_000
  const stale = await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: statusFetch(503), now })
  check('a later failure keeps the rows stale-but-labelled', stale?.models.length === 3 && (stale?.lastError ?? '').includes('503'))
  check('the ids the seat still offers are the ids that still route (route ≡ paint)', ids().join(',') === [SOL, HIDDEN, OFF].sort().join(',') && catalogue.getGptSeatAvailability().state === 'ready', ids().join(','))
  catalogue.__resetOpenaiCatalogueForTest()
  delete process.env.OPENAI_API_KEY
}

section('§4 the shape: provenance first, the grammar only for a typed id with no list')
{
  const source = readFileSync(join(ROOT, 'src/services/providers/openai/openaiCatalogue.ts'), 'utf8')
  check('the catalogue exports the seam\'s read by its exact name and shape', source.includes('export function cachedLiveIds(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string>'))
  const evaluate = source.slice(source.indexOf('export function evaluateGptCandidate'), source.indexOf('export function qualifiedGptCandidates'))
  check('the qualifier looks the id up in the list before the grammar decides anything', evaluate.indexOf('snapshot?.models.find(') < evaluate.indexOf("reason: 'not-gpt-family'") && evaluate.includes('if (!identity && !live)'))
  check('an unparsed candidate carries the honest minimal identity', evaluate.includes("identity ?? { family: 'gpt', canonicalId, unparsed: true }"))
  const qualified = source.slice(source.indexOf('export function qualifiedGptCandidates'), source.indexOf('export type GptSeatDisabledWhy'))
  check('the qualified order lists unparsed rows after the parsed rows', qualified.includes('unparsed === true ? 1 : 0'))
  const pins = readFileSync(join(ROOT, 'src/services/providers/openai/gptPins.ts'), 'utf8')
  check('the parsed identity type carries the discriminant; the parser itself is untouched', pins.includes('unparsed?: false') && /^export function parseGptModelId\(id: string\): GptModelIdentity \| undefined \{/m.test(pins))
  const frontier = readFileSync(join(ROOT, 'src/utils/model/providerFrontier.ts'), 'utf8')
  const frontierOpenai = frontier.slice(frontier.indexOf("case 'openai': {"), frontier.indexOf("case 'zai':"))
  check('the frontier ranking walks the dated pins through the parser, never a candidate identity', frontierOpenai.includes('for (const pin of GPT_DISPLAY_PINS)') && frontierOpenai.includes('parseGptModelId(pin.id)') && !frontierOpenai.includes('qualifiedGptCandidates'))
  const small = frontier.slice(frontier.indexOf('export function openaiSmallFastChoice'), frontier.indexOf('export function providerLightFact'))
  check('the small-fast and light choosers re-parse every served id and skip the unparsed ones', (small.match(/parseGptModelId\(raw\)/g) ?? []).length === 2 && small.includes('if (!identity) continue') && small.includes("if (!identity || identity.variant !== '') continue"))
  const options = readFileSync(join(ROOT, 'src/utils/model/modelOptions.ts'), 'utf8')
  const gptRows = options.slice(options.indexOf('function getQualifiedGptOptions'), options.indexOf('export interface KeyLanePin'))
  check("the picker's OpenAI rows come from the qualified list, named by the live row when the grammar has no name, with no prefix filter", gptRows.includes("qualifiedGptCandidates('primary', availability.sourceKind)") && gptRows.includes('gptDisplayName(id) ?? candidate.displayName') && !/startsWith\('gpt|\/\^gpt|parseGptModelId/.test(gptRows))
}

console.log('\n' + '═'.repeat(60))
console.log(failures === 0 ? 'OPENAI LIVE PROVENANCE — GREEN' : `${failures} OPENAI LIVE PROVENANCE CHECK(S) FAILED`)
console.log('═'.repeat(60))
process.exit(failures === 0 ? 0 : 1)
