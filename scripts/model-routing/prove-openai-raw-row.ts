#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'openai-raw-row-'))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(join(import.meta.dir, '..', '..'))
for (const key of [
  'OPENAI_API_KEY',
  'ZAI_API_KEY',
  'MERCURY_MODEL',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC',
  'MERCURY_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]) {
  delete process.env[key]
}
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_CHATGPT_BASE = 'http://127.0.0.1:9'
process.env.MERCURY_OPENAI_AUTH_BASE = 'http://127.0.0.1:9'

const pins = await import('../../src/services/providers/openai/gptPins.js')
const idSpaces = await import('../../src/services/providers/idSpaces.js')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const capabilities = await import('../../src/utils/model/capabilities.js')
const effort = await import('../../src/utils/effort.js')
const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { getModelOptions, OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')
const { validateModel } = await import('../../src/utils/model/validateModel.js')
const { describeAgentRuntimeRef, resolvePrimaryAgentBackend } = await import('../../src/services/providers/primaryBackend.js')
const { isExactEngineModelId, resolveEngineDispatch, unrecognisedModelWordRefusal } = await import('../../src/utils/swarm/engineDispatch.js')
const { __resetProviderDiscoveryForTest, refreshProviderDiscovery } = await import('../../src/utils/router/providerDiscovery.js')
const { renderModelName } = await import('../../src/utils/model/model.js')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const BASE = 'the base tree answers the other way'

console.log('============================================================')
console.log(' OpenAI lists a live id outside the gpt- grammar under its raw tag (the o-series shape, anchored on a digit)')
console.log('============================================================')

const RAW = 'o5-preview'
const GPT = 'gpt-6'
const EMBEDDING = 'text-embedding-3-large'
type Pins = typeof pins & {
  parseOpenaiModelId?: (id: string) => { family: string; canonicalId: string; variant: string; series?: number; major?: number } | undefined
  parseOSeriesModelId?: (id: string) => { family: string; canonicalId: string; variant: string; series: number } | undefined
}
const grammar = pins as Pins
const parseOpenai = grammar.parseOpenaiModelId

section('§1 THE SHAPE — the pure grammar module parses the family beyond gpt-: o<digit>[-variant], anchored on the digit')
{
  check(`the grammar module exports parseOpenaiModelId and parseOSeriesModelId (${BASE}: the family has the gpt- parse alone)`, typeof grammar.parseOpenaiModelId === 'function' && typeof grammar.parseOSeriesModelId === 'function')
  const raw = parseOpenai?.(RAW)
  check(`'${RAW}' parses as the o-series: series 5, variant 'preview', canonical '${RAW}'`, raw?.family === 'o-series' && raw.series === 5 && raw.variant === 'preview' && raw.canonicalId === RAW, JSON.stringify(raw))
  check("'o3' parses with no variant", parseOpenai?.('o3')?.family === 'o-series' && parseOpenai?.('o3')?.variant === '')
  check("'O5-Preview[served]' parses to the bare lowered canonical id (the window annotation is dressing)", parseOpenai?.('O5-Preview[served]')?.canonicalId === RAW)
  check("'o1-2024-12-17' (a dated spelling) parses", parseOpenai?.('o1-2024-12-17')?.family === 'o-series')
  check(`'${GPT}' still parses as the gpt family (major 6)`, parseOpenai?.(GPT)?.family === 'gpt' && parseOpenai?.(GPT)?.major === 6)
  check('the shapes outside the family answer undefined: opus · opus5 · o · o-mini · text-embedding-3-large · o5/x · o05', ['opus', 'opus5', 'o', 'o-mini', EMBEDDING, 'o5/x', 'o05'].every(id => parseOpenai?.(id) === undefined))
  check(`the gpt grammar itself is unchanged: parseGptModelId('${RAW}') stays undefined and parseGptModelId('${GPT}') parses`, pins.parseGptModelId(RAW) === undefined && pins.parseGptModelId(GPT)?.major === 6)
  check('the one pattern is exported for the id space to read', grammar.OPENAI_O_SERIES_ID_RE instanceof RegExp && typeof grammar.OPENAI_O_SERIES_ID_SPELLING === 'string', String(grammar.OPENAI_O_SERIES_ID_RE))
}

section('§2 THE ID SPACE — the shape routes to openai; every first-party alias stays first-party')
{
  const kind = (id: string, env: Record<string, string | undefined> = {}): string => {
    const r = idSpaces.recognizeModelId(id, env)
    return r.kind === 'declared' ? `declared:${r.route}` : r.kind === 'first-party' ? `first-party:${r.why}` : r.kind
  }
  check(`recognizeModelId('${RAW}') is declared:openai (${BASE}: unrecognised)`, kind(RAW) === 'declared:openai', kind(RAW))
  check(`classifyModelRoute('${RAW}') routes to openai (${BASE}: unrecognised)`, JSON.stringify(idSpaces.classifyModelRoute(RAW, {})) === JSON.stringify({ kind: 'route', route: 'openai' }), JSON.stringify(idSpaces.classifyModelRoute(RAW, {})))
  check(`declaredRouteOf('${RAW}') is openai (${BASE}: null)`, declaredRouteOf(RAW, {}) === 'openai', String(declaredRouteOf(RAW, {})))
  check("'o3' · 'O3' · 'o1-2024-12-17' · 'o5-preview[served]' all route to openai", ['o3', 'O3', 'o1-2024-12-17', 'o5-preview[served]'].every(id => declaredRouteOf(id, {}) === 'openai'))
  check('the first-party aliases keep their family: opus · opus5 · opus55 · opusplan (a bare o prefix would capture them)', kind('opus') === 'first-party:alias' && kind('opus5') === 'first-party:alias' && kind('opus55') === 'first-party:alias' && kind('opusplan') === 'first-party:alias')
  check('MERCURY_MODEL=opus and /model opus5 resolve first-party under the pin', idSpaces.classifyModelRoute('opus', { MERCURY_MODEL: 'opus' }).kind === 'route' && (idSpaces.classifyModelRoute('opus', { MERCURY_MODEL: 'opus' }) as { route?: string }).route === 'anthropic' && (idSpaces.classifyModelRoute('opus5', {}) as { route?: string }).route === 'anthropic')
  check("the shape is anchored on the digit: 'o' · 'o-mini' · 'ox5' stay unrecognised", kind('o') === 'unrecognised' && kind('o-mini') === 'unrecognised' && kind('ox5') === 'unrecognised')
  check("a carrier spelling stays carrier-shaped: 'openai/o5'", kind('openai/o5') === 'carrier-shaped')
  check(`the refusal sentence names the shape beside gpt-* (${BASE}: gpt-* alone)`, /gpt-\*\/o<digit>\*/.test(idSpaces.declaredIdSpacesLine()), idSpaces.declaredIdSpacesLine())
  check('the gpt class alias is still declared:openai', kind('gpt') === 'declared:openai')
}

type LiveRow = Record<string, unknown>
const fetchOf = (rows: LiveRow[]): typeof fetch =>
  (async () => new Response(JSON.stringify({ data: rows }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
process.env.OPENAI_API_KEY = 'prover-key'

section('§3 THE LIVE LIST DECIDES PRESENCE — an API-key list (bare rows): the o-series id is offered under its raw tag, the embedding id never')
{
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fetchOf([{ id: GPT }, { id: RAW, display_name: 'o5 preview' }, { id: EMBEDDING }]) })
  const raw = catalogue.evaluateGptCandidate(RAW, 'api-key')
  check(`'${RAW}' on the list is admitted (${BASE}: not-gpt-family)`, raw.ok, JSON.stringify(raw))
  check('…its identity is the o-series and its canonical id the raw tag', raw.ok && (raw.candidate.identity as { family: string }).family === 'o-series' && raw.candidate.identity.canonicalId === RAW, JSON.stringify(raw))
  check("…its display name is the raw tag even though the vendor names it ('o5 preview' rides the live row only)", raw.ok && raw.candidate.displayName === RAW && raw.candidate.live.displayName === 'o5 preview', JSON.stringify(raw))
  check('…and it carries no display pin', raw.ok && raw.candidate.pin === undefined)
  const embedding = catalogue.evaluateGptCandidate(EMBEDDING, 'api-key')
  check(`'${EMBEDDING}' on the same list is refused as outside the family (not-gpt-family)`, !embedding.ok && embedding.why.reason === 'not-gpt-family', JSON.stringify(embedding))
  const gpt = catalogue.evaluateGptCandidate(GPT, 'api-key')
  check(`'${GPT}' is admitted as before`, gpt.ok && (gpt.candidate.identity as { family: string }).family === 'gpt')
  const unlisted = catalogue.evaluateGptCandidate('o7', 'api-key')
  check(`an o-series id the list lacks ('o7') is refused as not in the live catalogue (${BASE}: not-gpt-family)`, !unlisted.ok && unlisted.why.reason === 'not-in-live-catalogue', JSON.stringify(unlisted))
  const ids = catalogue.qualifiedGptCandidates('primary', 'api-key').map(c => c.identity.canonicalId)
  check(`the qualified candidates carry both admitted ids and never the embedding (${BASE}: the gpt row alone)`, ids.includes(RAW) && ids.includes(GPT) && !ids.includes(EMBEDDING), ids.join(','))
  const seat = catalogue.getGptSeatAvailability()
  check(`the seat availability lists the raw id (${BASE}: absent)`, seat.state === 'ready' && seat.ids.includes(RAW) && !seat.ids.includes(EMBEDDING), JSON.stringify(seat))

  const options = getModelOptions()
  const row = options.find(o => o.value === RAW)
  check(`the picker lists the raw row: label '${RAW}', the OpenAI group, selectable (${BASE}: no row)`, row !== undefined && row.label === RAW && row.group === OPENAI_MODEL_GROUP && row.unavailable === undefined, JSON.stringify(row))
  check("…the model-facing description names the vendor's name and says the row is served under its raw id", (row?.descriptionForModel ?? '').includes('o5 preview') && /raw id/.test(row?.descriptionForModel ?? ''), String(row?.descriptionForModel))
  check(`…the operator-facing description is empty like every live row's`, row?.description === '')
  check(`the embedding id has no row`, options.find(o => o.value === EMBEDDING) === undefined)
  const gptRow = options.find(o => o.value === GPT)
  check(`the gpt row keeps the display owner's name ('GPT-6')`, gptRow?.label === 'GPT-6' && gptRow.unavailable === undefined, JSON.stringify(gptRow))
  check(`every readout paints the raw tag: renderModelName('${RAW}')`, renderModelName(RAW) === RAW, renderModelName(RAW))

  const admitted = await validateModel(RAW)
  check(`validateModel admits '${RAW}' against the live list (${BASE}: refused as an id no family declares)`, admitted.valid === true, JSON.stringify(admitted))
  const refused = await validateModel(EMBEDDING)
  check(`validateModel refuses '${EMBEDDING}'`, refused.valid === false, JSON.stringify(refused))

  const view = capabilities.gptEffortVocabularyView(RAW)
  check(`a bare row states no vocabulary: the effort view is unstated, the controls offer the ladder, the wire omits the key (${BASE}: not-gpt)`, view.state === 'unstated', JSON.stringify(view))
  const profile = raw.ok ? catalogue.resolveGptReasoningProfile('high', raw.candidate.live) : undefined
  check('…the wire profile sends no reasoning key for an unstated vocabulary', profile !== undefined && profile.wireEffort === undefined, JSON.stringify(profile))
  check('a bare row states no window: the budget is the conservative default', getContextWindowForModel(RAW) === capabilities.MODEL_CONTEXT_WINDOW_DEFAULT, String(getContextWindowForModel(RAW)))

  check(`the primary backend for '${RAW}' is the Responses lane (${BASE}: none)`, resolvePrimaryAgentBackend(RAW)?.id === 'openai-responses', String(resolvePrimaryAgentBackend(RAW)?.id))
  const ref = describeAgentRuntimeRef(RAW)
  check(`the runtime ref routes it to openai with the o-series family (${BASE}: unrecognised, unknown family)`, ref.route === 'openai' && ref.provider === 'openai' && ref.backend === 'openai-responses' && ref.family.kind === 'o-series', JSON.stringify(ref))
  check("a gpt ref's family is unchanged", describeAgentRuntimeRef('gpt-5.6-sol').family.kind === 'gpt')

  check(`the engine grammar reads '${RAW}' as an exact engine id (${BASE}: not a shape it validates)`, isExactEngineModelId(RAW) && unrecognisedModelWordRefusal(RAW) === null)
  check(`the engine grammar still refuses '${EMBEDDING}' by name`, (unrecognisedModelWordRefusal(EMBEDDING) ?? '').includes(`'${EMBEDDING}'`))
  __resetProviderDiscoveryForTest()
  await refreshProviderDiscovery('openai', { force: true })
  let dispatched: { backend: string; model: string; displayLabel: string } | null = null
  let dispatchError = ''
  try {
    dispatched = await resolveEngineDispatch(RAW)
  } catch (error) {
    dispatchError = error instanceof Error ? error.message : String(error)
  }
  check(`an agent naming '${RAW}' dispatches on the openai engine with the raw tag as its label (${BASE}: no engine dispatch)`, dispatched?.backend === 'openai' && dispatched.model === RAW && dispatched.displayLabel === RAW, dispatchError || JSON.stringify(dispatched))
}

section('§4 A LIST STATING FACTS — the row\'s own levels and window ride; the gpt class alias resolves among gpt-* rows only')
{
  const rich = (id: string, priority: number, efforts: readonly string[], contextWindow: number, maxContextWindow: number, defaultEffort: string): LiveRow => ({
    id,
    visibility: 'list',
    priority,
    supported_reasoning_levels: efforts.map(e => ({ effort: e })),
    default_reasoning_level: defaultEffort,
    context_window: contextWindow,
    max_context_window: maxContextWindow,
    input_modalities: ['text'],
  })
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', {
    force: true,
    fetchImpl: fetchOf([rich(RAW, 1, ['low', 'medium', 'high'], 200_000, 400_000, 'medium'), rich(GPT, 2, ['low', 'medium', 'high', 'xhigh'], 272_000, 272_000, 'high'), { id: EMBEDDING }]),
  })
  const ids = catalogue.qualifiedGptCandidates('primary', 'api-key').map(c => c.identity.canonicalId)
  check(`the list's priority orders the candidates: '${RAW}' first (${BASE}: absent)`, ids[0] === RAW && ids[1] === GPT, ids.join(','))
  const gptClass = (catalogue as { gptClassCandidate?: (role: string, kind: string) => { identity: { canonicalId: string } } | undefined }).gptClassCandidate
  check(`the catalogue exports the gpt class head (${BASE}: no such export)`, typeof gptClass === 'function')
  check(`the gpt class head is '${GPT}', the top gpt-* row, never the o-series row above it`, gptClass?.('specialist', 'api-key')?.identity.canonicalId === GPT, String(gptClass?.('specialist', 'api-key')?.identity.canonicalId))
  __resetProviderDiscoveryForTest()
  await refreshProviderDiscovery('openai', { force: true })
  let alias: { model: string } | null = null
  try {
    alias = await resolveEngineDispatch('gpt')
  } catch (error) {
    alias = { model: `threw: ${error instanceof Error ? error.message : String(error)}` }
  }
  check(`an agent naming the 'gpt' class lands on '${GPT}'`, alias?.model === GPT, String(alias?.model))
  const view = capabilities.gptEffortVocabularyView(RAW)
  check(`the stated levels are the row's vocabulary (low · medium · high, default medium) (${BASE}: not-gpt)`, view.state === 'live' && JSON.stringify(view.vocabulary) === JSON.stringify(['low', 'medium', 'high']) && view.defaultEffort === 'medium', JSON.stringify(view))
  check("the effort owner steps a request through it: 'high' rides, 'max' steps down to 'high' with the asked word on the record", effort.resolveEffortTruth(RAW, 'high').wire === 'high' && effort.resolveEffortTruth(RAW, 'max').wire === 'high' && effort.resolveEffortTruth(RAW, 'max').adjustedFrom === 'max', JSON.stringify(effort.resolveEffortTruth(RAW, 'max')))
  const live = catalogue.evaluateGptCandidate(RAW, 'api-key')
  const profile = live.ok ? catalogue.resolveGptReasoningProfile('medium', live.candidate.live) : undefined
  check("the wire profile sends the row's own word", profile?.wireEffort === 'medium' && profile.source === 'user', JSON.stringify(profile))
  check(`the budget is the row's declared ceiling (400,000) on the bare id (${BASE}: the conservative default)`, getContextWindowForModel(RAW) === 400_000, String(getContextWindowForModel(RAW)))
  check("the [served] opt-down budgets the row's served default (200,000)", getContextWindowForModel(`${RAW}[served]`) === 200_000, String(getContextWindowForModel(`${RAW}[served]`)))
  check('the ceiling reads through the catalogue for the raw id', catalogue.liveGptContextCeiling(RAW) === 400_000 && catalogue.liveGptContextWindow(RAW) === 200_000)
  const options = getModelOptions()
  const row = options.find(o => o.value === RAW)
  check(`the picker's raw row stands with the stated list too`, row !== undefined && row.label === RAW && row.unavailable === undefined, JSON.stringify(row))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
