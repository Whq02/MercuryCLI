#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'gpt6-astra-row-'))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(join(import.meta.dir, '..', '..'))
for (const key of [
  'OPENAI_API_KEY',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_EFFORT_LEVEL',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[key]
}
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

const pins = await import('../../src/services/providers/openai/gptPins.js')
const catalogue = await import('../../src/services/providers/openai/openaiCatalogue.js')
const capabilities = await import('../../src/utils/model/capabilities.js')
const effort = await import('../../src/utils/effort.js')
const cost = await import('../../src/utils/modelCost.js')
const model = await import('../../src/utils/model/model.js')
const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { providerFrontierFact, providerLightFact } = await import('../../src/utils/model/providerFrontier.js')
const { getModelOptions, OPENAI_MODEL_GROUP } = await import('../../src/utils/model/modelOptions.js')
const { ResponsesStreamFold } = await import('../../src/services/providers/openai/openaiWire.js')
const { streamOneOpenaiAttempt } = await import('../../src/services/providers/openai/openaiCallModel.js')
import type { OpenaiStreamEvent } from '../../src/services/providers/openai/openaiWire.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' GPT-6 Astra — one row in the one table (pure)')
console.log('============================================================')

const ID = 'gpt-6-astra'
const NAME = 'GPT-6 Astra'
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const

section('§1 THE ROW — the pin states the model-page facts; everything derives')
{
  const pin = pins.gptDisplayPin(ID)
  check('the row exists in the one table', pin !== undefined)
  check('the table lists it FIRST (newest first, like the 5.6 rows before it)', pins.GPT_DISPLAY_PINS[0]?.id === ID)
  check(`the display name is '${NAME}'`, pin?.displayName === NAME)
  check('the window is 1,050,000', pin?.contextWindow === 1_050_000, String(pin?.contextWindow))
  check('the output ceiling is 128,000', pin?.outputMax === 128_000, String(pin?.outputMax))
  check(
    'the four published prices: $10 in · $1 cached · $12.5 cache write · $50 out',
    pin?.costInPerMtok === 10 && pin?.cachedInPerMtok === 1 && pin?.cacheWritePerMtok === 12.5 && pin?.costOutPerMtok === 50,
    JSON.stringify(pin),
  )
  check('the knowledge cutoff is recorded', pin?.knowledgeCutoff === '2026-04-30', String(pin?.knowledgeCutoff))
  check('the row is a DATED observation', /^\d{4}-\d{2}-\d{2}$/.test(pin?.observedAt ?? ''), String(pin?.observedAt))
  check('the row carries the rollout caveat for its unavailable copy', typeof pin?.availabilityNote === 'string' && pin.availabilityNote.length > 0)

  const identity = pins.parseGptModelId(ID)
  check(
    'the grammar parses the id: major 6 · minor 0 · variant astra',
    identity?.major === 6 && identity.minor === 0 && identity.variant === 'astra' && identity.canonicalId === ID,
    JSON.stringify(identity),
  )
  check('the served-window annotation is dressing on this id too', pins.parseGptModelId(`${ID}[served]`)?.canonicalId === ID)
  check(
    'the display name reaches the selector estate through the one owner',
    pins.gptDisplayName(ID) === NAME &&
      model.getPublicModelDisplayName(ID) === NAME &&
      model.getMarketingNameForModel(ID) === NAME &&
      model.renderModelName(ID) === NAME,
    `${pins.gptDisplayName(ID)} · ${model.getPublicModelDisplayName(ID)} · ${model.getMarketingNameForModel(ID)} · ${model.renderModelName(ID)}`,
  )

  const pricing = cost.resolveModelPricing(ID)
  check(
    'the cost owner prices the id at the four recorded rates (basis recorded)',
    pricing.basis === 'recorded' &&
      pricing.costs.inputTokens === 10 &&
      pricing.costs.outputTokens === 50 &&
      pricing.costs.promptCacheReadTokens === 1 &&
      pricing.costs.promptCacheWriteTokens === 12.5,
    JSON.stringify(pricing),
  )
  check("the pricing string is '$10/$50 per Mtok'", cost.getModelPricingString(ID) === '$10/$50 per Mtok', String(cost.getModelPricingString(ID)))
  const usd = cost.calculateUSDCost(ID, {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
  })
  check('a million of each: 10 + 50 + 1 + 12.5 = 73.5 USD', Math.abs(usd - 73.5) < 1e-6, String(usd))
  const sol = cost.resolveModelPricing('gpt-5.6-sol')
  check(
    'a pin stating no cache-write rate still writes at its input rate (the 5.6 rows unchanged)',
    sol.basis === 'recorded' && sol.costs.promptCacheWriteTokens === sol.costs.inputTokens,
    JSON.stringify(sol),
  )

  const out = capabilities.getModelMaxOutputTokens(ID)
  check('the output pair reads the pin: 64,000 default · 128,000 ceiling', out.default === 64_000 && out.upperLimit === 128_000, JSON.stringify(out))
  check('uncredentialed, the budget is the pinned window (a dated record, not a live claim)', getContextWindowForModel(ID) === 1_050_000, String(getContextWindowForModel(ID)))

  const frontier = providerFrontierFact('openai')
  check(`the openai frontier fact is the row (the newest by the grammar): ${NAME}`, frontier?.modelId === ID && frontier.displayName === NAME, JSON.stringify(frontier))
  const light = providerLightFact('openai')
  check('the openai light fact is unchanged (the newest variant-less row below the frontier)', light?.modelId === 'gpt-5.5', JSON.stringify(light))
}

section('§2 THE LIVE LIST DECIDES PRESENCE — served ⇒ the row; unserved ⇒ no selectable row')
type LiveRow = Record<string, unknown>
const liveRow = (id: string, name: string, priority: number, efforts: readonly string[], contextWindow: number): LiveRow => ({
  slug: id,
  display_name: name,
  visibility: 'list',
  priority,
  supported_reasoning_levels: efforts.map(e => ({ effort: e, description: e })),
  default_reasoning_level: 'high',
  context_window: contextWindow,
  input_modalities: ['text', 'image'],
  supported_in_api: true,
})
const LIVE_ASTRA = liveRow(ID, NAME, 1, LADDER, 1_050_000)
const LIVE_SOL = liveRow('gpt-5.6-sol', 'GPT-5.6 Sol', 2, ['low', 'medium', 'high', 'xhigh'], 272_000)
const fetchOf = (models: LiveRow[]): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ models }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

process.env.OPENAI_API_KEY = 'prover-key'
{
  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fetchOf([LIVE_ASTRA, LIVE_SOL]) })

  const evaluated = catalogue.evaluateGptCandidate(ID, 'api-key')
  check(
    'served ⇒ qualified, wearing the name and carrying the pin',
    evaluated.ok && evaluated.candidate.displayName === NAME && evaluated.candidate.pin?.id === ID,
    JSON.stringify(evaluated),
  )
  const head = catalogue.qualifiedGptCandidates('primary', 'api-key')[0]
  check('the class alias resolves to it — the top-priority qualified row', head?.identity.canonicalId === ID, String(head?.identity.canonicalId))
  const availability = catalogue.getGptSeatAvailability()
  check('the seat availability lists it first', availability.state === 'ready' && availability.ids[0] === ID, JSON.stringify(availability))

  const options = getModelOptions()
  const row = options.find(o => o.value === ID)
  check(
    'the picker row: the name, the OpenAI group, selectable',
    row !== undefined && row.label === NAME && row.group === OPENAI_MODEL_GROUP && row.unavailable === undefined,
    JSON.stringify(row),
  )
  const solRow = options.find(o => o.value === 'gpt-5.6-sol')
  check('the served 5.6 row stands beside it, selectable', solRow !== undefined && solRow.unavailable === undefined, JSON.stringify(solRow))
  const astraIndex = options.findIndex(o => o.value === ID)
  const solIndex = options.findIndex(o => o.value === 'gpt-5.6-sol')
  check('the rows keep the live priority order (Astra above Sol)', astraIndex >= 0 && solIndex > astraIndex, `${astraIndex} vs ${solIndex}`)

  const view = capabilities.gptEffortVocabularyView(ID)
  check('the live vocabulary is the five-level ladder', view.state === 'live' && JSON.stringify(view.vocabulary) === JSON.stringify(LADDER), JSON.stringify(view))
  check('max is supported', capabilities.modelSupportsMaxEffort(ID) && capabilities.getMaxSupportedEffortLevel(ID) === 'max')
  check('xhigh is supported', capabilities.modelSupportsXHighEffort(ID))
  check("applied 'max' stays 'max'", effort.resolveAppliedEffort(ID, 'max') === 'max', String(effort.resolveAppliedEffort(ID, 'max')))
  check("applied 'xhigh' stays 'xhigh'", effort.resolveAppliedEffort(ID, 'xhigh') === 'xhigh', String(effort.resolveAppliedEffort(ID, 'xhigh')))
  check("no effort set ⇒ the live default ('high')", effort.resolveAppliedEffort(ID, undefined) === 'high', String(effort.resolveAppliedEffort(ID, undefined)))
  const live = catalogue.evaluateGptCandidate(ID, 'api-key')
  const liveModel = live.ok ? live.candidate.live : undefined
  const pMax = liveModel ? catalogue.resolveGptReasoningProfile('max', liveModel) : undefined
  const pXhigh = liveModel ? catalogue.resolveGptReasoningProfile('xhigh', liveModel) : undefined
  check("the wire profile sends 'max' as the user's own choice", pMax?.wireEffort === 'max' && pMax.source === 'user', JSON.stringify(pMax))
  check("the wire profile sends 'xhigh' as the user's own choice", pXhigh?.wireEffort === 'xhigh' && pXhigh.source === 'user', JSON.stringify(pXhigh))
  check('the live row admits images', liveModel?.inputModalities?.includes('image') === true)

  check('credentialed, the budget is the SERVED window (1,050,000 here)', getContextWindowForModel(ID) === 1_050_000, String(getContextWindowForModel(ID)))
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  check('the 1M kill-switch still caps it', getContextWindowForModel(ID) === 200_000, String(getContextWindowForModel(ID)))
  delete process.env.MERCURY_DISABLE_1M_CONTEXT

  catalogue.__resetOpenaiCatalogueForTest()
  await catalogue.refreshOpenaiCatalogue('api-key', { force: true, fetchImpl: fetchOf([LIVE_SOL]) })
  const unserved = catalogue.evaluateGptCandidate(ID, 'api-key')
  check("unserved ⇒ disqualified: 'not-in-live-catalogue'", !unserved.ok && unserved.why.reason === 'not-in-live-catalogue', JSON.stringify(unserved))
  const headWithout = catalogue.qualifiedGptCandidates('primary', 'api-key')[0]
  check('the class alias resolves to the served row instead', headWithout?.identity.canonicalId === 'gpt-5.6-sol', String(headWithout?.identity.canonicalId))
  const withoutRow = getModelOptions().find(o => o.value === ID)
  const pin = pins.gptDisplayPin(ID)
  check(
    "unserved ⇒ the picker's row is unavailable (never selectable), carrying the resolver's reason and the pin's rollout note",
    withoutRow !== undefined &&
      typeof withoutRow.unavailable === 'string' &&
      withoutRow.unavailable.includes('not served by the connected') &&
      pin?.availabilityNote !== undefined &&
      withoutRow.unavailable.includes(pin.availabilityNote),
    JSON.stringify(withoutRow),
  )
  check('unserved, the effort view reports the live truth as unavailable for it (no invented ladder)', capabilities.gptEffortVocabularyView(ID).state !== 'live', JSON.stringify(capabilities.gptEffortVocabularyView(ID)))
  catalogue.__resetOpenaiCatalogueForTest()
}
delete process.env.OPENAI_API_KEY

section('§3 THE WIRE — a fixture Responses stream on the id: the summary and the registers land')
{
  const SUMMARY = 'weighing the tide tables before answering'
  const NOTE = 'Checking the gauges.'
  const ANSWER = 'The tide turns at noon.'
  const fold = new ResponsesStreamFold()
  const events: OpenaiStreamEvent[] = []
  const payloads: unknown[] = [
    { type: 'response.created', response: { id: 'resp_astra_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_astra_1', summary: [] } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs_astra_1', delta: SUMMARY },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_astra_1', summary: [{ type: 'summary_text', text: SUMMARY }], encrypted_content: 'astra-opaque' },
    },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'message', id: 'msg_astra_1', role: 'assistant', status: 'in_progress', content: [], phase: 'commentary' } },
    { type: 'response.output_text.delta', item_id: 'msg_astra_1', delta: NOTE },
    {
      type: 'response.output_item.done',
      output_index: 1,
      item: { type: 'message', id: 'msg_astra_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: NOTE, annotations: [] }], phase: 'commentary' },
    },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'message', id: 'msg_astra_2', role: 'assistant', status: 'in_progress', content: [], phase: 'final_answer' } },
    { type: 'response.output_text.delta', item_id: 'msg_astra_2', delta: ANSWER },
    {
      type: 'response.output_item.done',
      output_index: 2,
      item: { type: 'message', id: 'msg_astra_2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: ANSWER, annotations: [] }], phase: 'final_answer' },
    },
    { type: 'response.completed', response: { id: 'resp_astra_1', model: ID, usage: { input_tokens: 40, output_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } },
  ]
  for (const p of payloads) events.push(...fold.fold(p))
  const types = events.map(e => e.type)
  check('the fold streams the summary as a reasoning delta', events.some(e => e.type === 'reasoning-delta' && e.text === SUMMARY), types.join(','))
  const starts = events.filter((e): e is Extract<OpenaiStreamEvent, { type: 'text-item-start' }> => e.type === 'text-item-start')
  check('two message items open, each with its register', starts.length === 2 && starts[0]?.phase === 'commentary' && starts[1]?.phase === 'final_answer', JSON.stringify(starts))
  const finish = events.find((e): e is Extract<OpenaiStreamEvent, { type: 'finish' }> => e.type === 'finish')
  check('the finish carries the reasoning item and the two labelled message items in order', finish !== undefined && finish.reasoningItems.length === 1 && JSON.stringify(finish.orderedItems.map(i => i.type)) === JSON.stringify(['reasoning', 'message', 'message']), JSON.stringify(finish?.orderedItems.map(i => i.type)))

  const source = (async function* () {
    for (const e of events) yield e
  })() as never
  const gen = streamOneOpenaiAttempt({
    _eventsForTesting: source,
    request: { model: ID, input: [], stream: true } as never,
    auth: { baseUrl: 'https://unused.invalid', headers: {}, account: { kind: 'api-key', label: 'fixture source' } } as never,
    signal: new AbortController().signal,
    tools: [] as never,
    options: { querySource: 'sdk' } as never,
    modelId: ID,
    messages: [] as never,
    settlementNotes: [] as never,
    pulseMain: false,
    pulseGeneration: 0,
    contractDigest: 'prover-digest',
  })
  const blocks: Array<{ type: string; text: string; phase?: string }> = []
  const settled: Array<{ apexProviderTurn?: { items?: Array<{ type?: string; phase?: string }> }; message?: { model?: string } }> = []
  let r = await gen.next()
  while (!r.done) {
    const v = r.value as { type: string; message?: { model?: string; content?: Array<Record<string, unknown>> }; apexProviderTurn?: { items?: Array<{ type?: string; phase?: string }> } }
    if (v.type === 'assistant') {
      settled.push(v)
      for (const b of v.message?.content ?? []) {
        blocks.push({
          type: String(b.type),
          text: typeof b.text === 'string' ? b.text : typeof b.thinking === 'string' ? b.thinking : '',
          ...(typeof b.phase === 'string' ? { phase: b.phase } : {}),
        })
      }
    }
    r = await gen.next()
  }
  const thinking = blocks.filter(b => b.type === 'thinking')
  const texts = blocks.filter(b => b.type === 'text')
  check('the runtime mints a thinking block from the summary', thinking.length >= 1 && thinking.some(b => b.text.includes(SUMMARY)), JSON.stringify(blocks))
  check(
    'the runtime mints two text blocks carrying their registers (the working note, then the answer)',
    texts.length === 2 && texts[0]?.text === NOTE && texts[0].phase === 'commentary' && texts[1]?.text === ANSWER && texts[1].phase === 'final_answer',
    JSON.stringify(texts),
  )
  const record = settled.at(-1)?.apexProviderTurn
  check(
    'the settled record replays the reasoning item and both labelled message items',
    JSON.stringify(record?.items?.map(i => [i.type, i.phase ?? null])) === JSON.stringify([['reasoning', null], ['message', 'commentary'], ['message', 'final_answer']]),
    JSON.stringify(record?.items?.map(i => [i.type, i.phase ?? null])),
  )
  check('the minted turn names the model it ran on', settled.some(s => s.message?.model === ID), JSON.stringify(settled.map(s => s.message?.model)))
}

console.log(failures === 0 ? '\nprove-gpt6-astra-row: ALL LAWS HOLD' : `\nprove-gpt6-astra-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
