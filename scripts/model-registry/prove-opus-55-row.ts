#!/usr/bin/env bun
import { mkdtempSync as mkScratch } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as pathJoin } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkScratch(pathJoin(osTmp(), 'opus-55-row-proof-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = proofHome
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

for (const k of [
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
]) {
  delete process.env[k]
}

const {
  firstPartyNameToCanonical,
  getCanonicalName,
  getMarketingNameForModel,
  getPublicModelName,
  parseUserSpecifiedModel,
  renderModelChip,
  renderModelName,
} = await import('../../src/utils/model/model.ts')
const { recognizeModelId } = await import('../../src/services/providers/idSpaces.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ID = 'claude-opus-5-5'
const PREVIOUS = 'claude-opus-5'

section('§1 the fold order and the names: claude-opus-5-5 is its own canonical, never swallowed by the opus-5 arm')
{
  check('its own canonical', getCanonicalName(ID) === ID, getCanonicalName(ID))
  check('the [1m] twin folds to the same canonical', getCanonicalName(`${ID}[1m]`) === ID, getCanonicalName(`${ID}[1m]`))
  check('a spelling with case folds to the same canonical', getCanonicalName('Claude-Opus-5-5') === ID, getCanonicalName('Claude-Opus-5-5'))
  check('the first-party fold agrees', firstPartyNameToCanonical(ID) === ID, firstPartyNameToCanonical(ID))
  check('Opus 5 keeps its own canonical (the previous generation is not the newest)', getCanonicalName(PREVIOUS) === PREVIOUS, getCanonicalName(PREVIOUS))
  check('a dated Opus 5 spelling still folds onto Opus 5, never onto 5.5', getCanonicalName('claude-opus-5-20260401') === PREVIOUS, getCanonicalName('claude-opus-5-20260401'))
  check('a carrier-shaped row never joins the first-party fold', getCanonicalName('openrouter/anthropic/claude-opus-5-5') === 'openrouter/anthropic/claude-opus-5-5')
  check("the one display owner names it 'Opus 5.5'", renderModelName(ID) === 'Opus 5.5', renderModelName(ID))
  check("the marketing name is 'Opus 5.5'", getMarketingNameForModel(ID) === 'Opus 5.5', String(getMarketingNameForModel(ID)))
  check("the [1m] twin displays as 'Opus 5.5 (1M context)'", renderModelName(`${ID}[1m]`) === 'Opus 5.5 (1M context)', renderModelName(`${ID}[1m]`))
  check("the chip reads 'Opus 5.5'", renderModelChip(ID) === 'Opus 5.5', renderModelChip(ID))
  check("the commit-trailer name reads 'Claude Opus 5.5'", getPublicModelName(ID) === 'Claude Opus 5.5', getPublicModelName(ID))
  check("Opus 5 still displays as 'Opus 5'", renderModelName(PREVIOUS) === 'Opus 5', renderModelName(PREVIOUS))
  check("the exact-generation alias 'opus55' resolves to the bare id", parseUserSpecifiedModel('opus55') === ID, parseUserSpecifiedModel('opus55'))
  check("'opus55[1m]' keeps its rider", parseUserSpecifiedModel('opus55[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('opus55[1m]'))
  check("the exact-generation alias 'opus5' still names Opus 5", parseUserSpecifiedModel('opus5') === PREVIOUS, parseUserSpecifiedModel('opus5'))
  check('the bare id passes through the setting parser byte-identical', parseUserSpecifiedModel(ID) === ID, parseUserSpecifiedModel(ID))
  const recognised = recognizeModelId('opus55')
  check("the id space recognises 'opus55' as a first-party alias spelling (the opus5 shape)", recognised.kind === 'first-party' && recognised.why === 'alias', JSON.stringify(recognised))
  check('the id space recognises the bare id by its claude- mark', recognizeModelId(ID).kind === 'first-party')
}

section("§2 the row: the opus family's newest generation, its class, its picker rows, its cost tier, its launch effort and its capability truth")
{
  const { FAMILY_GENERATIONS, newestGenerationKey, previousGenerationKeys } = await import('../../src/utils/model/configs.ts')
  const { getDefaultOpusModel, isDefaultOpusNatively1M, renderModelSetting, renderDefaultModelSetting } = await import('../../src/utils/model/model.ts')
  const { classOfModel } = await import('../../src/utils/router/modelRegistry.ts')
  const { listAnthropicModels, resolveAnthropicModel, routeEffortsFor } = await import('../../src/utils/router/providers/anthropic.ts')
  const { focusedOptionSupports1m, getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
  const { resolveCatalogueSpelling } = await import('../../src/utils/model/modelSpellingFold.ts')
  const { calculateUSDCost, getModelPricingString, resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const effort = await import('../../src/utils/effort.ts')
  const caps = await import('../../src/utils/model/capabilities.ts')
  const { foldLegacyWorkerModelKey } = await import('../../src/services/concourse/workerModels.ts')
  const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')

  check("the generation table lists opus55 first, Opus 5 second (newest first)", FAMILY_GENERATIONS.opus[0] === 'opus55' && FAMILY_GENERATIONS.opus[1] === 'opus5', FAMILY_GENERATIONS.opus.join(','))
  check("newestGenerationKey('opus') is opus55", newestGenerationKey('opus') === 'opus55')
  check('the previous generations are Opus 5, 4.8, 4.7, 4.6 in that order', previousGenerationKeys('opus').join(',') === 'opus5,opus48,opus47,opus46', previousGenerationKeys('opus').join(','))
  check("the family default is the bare id (no env pin)", getDefaultOpusModel() === ID, getDefaultOpusModel())
  check("the family word 'opus' resolves to it", parseUserSpecifiedModel('opus') === ID, parseUserSpecifiedModel('opus'))
  check("'opus[1m]' keeps its rider on the new row", parseUserSpecifiedModel('opus[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('opus[1m]'))
  check('a retired large id remaps onto the newest row', parseUserSpecifiedModel('claude-opus-4-1-20250805') === ID, parseUserSpecifiedModel('claude-opus-4-1-20250805'))
  check("the family word renders capitalised, the default setting renders the row's name", renderModelSetting('opus') === 'Opus' && renderDefaultModelSetting('opus') === 'Opus 5.5', `${renderModelSetting('opus')} / ${renderDefaultModelSetting('opus')}`)
  check('the large default is natively 1M', isDefaultOpusNatively1M())
  check("a crew record's 'opus' folds to the newest row", foldLegacyWorkerModelKey('opus') === ID, foldLegacyWorkerModelKey('opus'))

  check("the router classifies the id 'opus'", classOfModel(ID) === 'opus', String(classOfModel(ID)))
  check("the router classifies the family word 'opus'", classOfModel('opus') === 'opus', String(classOfModel('opus')))
  check("the router still classifies Opus 5 'opus'", classOfModel(PREVIOUS) === 'opus', String(classOfModel(PREVIOUS)))
  const adaptive = resolveAnthropicModel('opus', 'adaptive')
  const quality = resolveAnthropicModel('opus', 'quality')
  check('the seat table resolves the opus class to the new row at 1M', adaptive?.model === ID && adaptive.contextWindow === 1_000_000, JSON.stringify(adaptive))
  check("the seat's default efforts per posture are unchanged (xhigh; max on quality)", adaptive?.effort === 'xhigh' && quality?.effort === 'max', `${adaptive?.effort}/${quality?.effort}`)
  check("the seat listing's opus row is labelled by the display owner", listAnthropicModels().some(m => m.ref.model === ID && m.displayLabel === 'Opus 5.5'), JSON.stringify(listAnthropicModels().map(m => [m.ref.model, m.displayLabel])))
  check('the route ladder reaches max on the row', routeEffortsFor(ID).join(',') === 'high,xhigh,max', routeEffortsFor(ID).join(','))

  const rows = getModelOptions({ anthropicCredentialed: () => true }).filter(o => o.group === undefined)
  const values = rows.map(o => o.value)
  const at = (value: string): number => values.indexOf(value)
  check('the picker lists the new row once, labelled Opus 5.5, selectable', rows.filter(o => o.value === ID).length === 1 && rows.find(o => o.value === ID)?.label === 'Opus 5.5' && rows.find(o => o.value === ID)?.unavailable === undefined, JSON.stringify(values))
  check("the family alias row dedups onto the explicit row (one model, one row)", !values.includes('opus') && !values.includes('opus[1m]'), JSON.stringify(values))
  check('Opus 5 stays a selectable literal row labelled Opus 5', rows.find(o => o.value === PREVIOUS)?.label === 'Opus 5' && rows.find(o => o.value === PREVIOUS)?.unavailable === undefined)
  check('a natively-1M row never grows a (1M context) twin: neither Opus 5.5 nor Opus 5', !values.includes(`${ID}[1m]`) && !values.includes(`${PREVIOUS}[1m]`), JSON.stringify(values))
  check('the suffix-1M previous generations keep their twins', values.includes('claude-opus-4-8[1m]') && values.includes('claude-opus-4-6[1m]'), JSON.stringify(values))
  check('the previous generations list newest first: Opus 5 before Opus 4.8', at(PREVIOUS) !== -1 && at(PREVIOUS) < at('claude-opus-4-8'), JSON.stringify(values))
  check("the newest row keeps the explicit row's place at the section's end, after Sonnet 5", at(ID) === values.length - 1 && at('claude-sonnet-5') === values.length - 2, JSON.stringify(values))
  check("the spoken spelling 'opus 5.5' resolves to the row", resolveCatalogueSpelling('opus 5.5') === ID && parseUserSpecifiedModel('Opus 5.5') === ID, `${String(resolveCatalogueSpelling('opus 5.5'))} / ${parseUserSpecifiedModel('Opus 5.5')}`)
  check("the spoken spelling 'opus 5' still resolves to Opus 5", resolveCatalogueSpelling('opus 5') === PREVIOUS, String(resolveCatalogueSpelling('opus 5')))
  check('the 1M toggle never lights on the natively-1M rows', !focusedOptionSupports1m(ID) && !focusedOptionSupports1m(PREVIOUS))

  const pricing = resolveModelPricing(ID)
  check('the cost tier is recorded: $4 in, $20 out, $5 5m write, $0.20 cache read', pricing.basis === 'recorded' && pricing.costs.inputTokens === 4 && pricing.costs.outputTokens === 20 && pricing.costs.promptCacheWriteTokens === 5 && pricing.costs.promptCacheReadTokens === 0.2, JSON.stringify(pricing))
  check("the price string reads '$4/$20 per Mtok'", getModelPricingString(ID) === '$4/$20 per Mtok', String(getModelPricingString(ID)))
  const oneHour = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })
  const fiveMinute = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  const read = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })
  check('a million 1h-written tokens cost $8, 5m-written $5, read $0.20', Math.abs(oneHour - 8) < 1e-9 && Math.abs(fiveMinute - 5) < 1e-9 && Math.abs(read - 0.2) < 1e-9, `${oneHour}/${fiveMinute}/${read}`)
  check("the [1m] twin prices at the same tier", resolveModelPricing(`${ID}[1m]`).basis === 'recorded' && resolveModelPricing(`${ID}[1m]`).costs.inputTokens === 4)
  check('Opus 5 keeps its $5/$25 tier with the standard cache read', getModelPricingString(PREVIOUS) === '$5/$25 per Mtok' && resolveModelPricing(PREVIOUS).costs.promptCacheReadTokens === 0.5, String(getModelPricingString(PREVIOUS)))

  check("the launch effort pins 'high' (the owner's ruling; the vendor's own default is medium)", effort.isLaunchEffortPinned(ID) && effort.getLaunchDefaultEffort(ID) === 'high' && effort.getDefaultEffortForModel(ID) === 'high', `${effort.isLaunchEffortPinned(ID)} ${effort.getLaunchDefaultEffort(ID)} ${String(effort.getDefaultEffortForModel(ID))}`)
  const truth = effort.resolveEffortTruth(ID, undefined)
  check("with nothing set the request carries 'high' and the label says so", truth.applied === 'high' && truth.wire === 'high' && truth.label === 'high', JSON.stringify(truth))
  check('the row serves the whole ladder (xhigh and max included)', effort.selectableEffortLevelsForLadder(ID).join(',') === 'low,medium,high,xhigh,max' && caps.getMaxSupportedEffortLevel(ID) === 'max', effort.selectableEffortLevelsForLadder(ID).join(','))
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: { opus5: true } }))
  check("unpinning Opus 5's launch flag leaves the 5.5 row pinned (its own flag)", effort.isLaunchEffortPinned(ID) && !effort.isLaunchEffortPinned(PREVIOUS))
  effort.unpinAllLaunchEffort()
  check('unpinning every family covers the new flag too', effort.allLaunchEffortUnpinned() && !effort.isLaunchEffortPinned(ID) && (getGlobalConfig() as { launchEffortUnpins?: Record<string, boolean> }).launchEffortUnpins?.opus55 === true)
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: {} }))

  check('adaptive thinking, temperature refused, 1M native, 128K out', caps.modelSupportsAdaptiveThinking(ID) && caps.modelSupportsThinking(ID) && !caps.modelSupportsTemperature(ID) && caps.modelSupports1M(ID) && caps.getContextWindowForModel(ID) === 1_000_000 && caps.getModelMaxOutputTokens(ID).upperLimit === 128_000 && caps.getModelMaxOutputTokens(ID).default === 64_000)
  check('the context resolution is the first-party static pin', caps.resolveContextWindow(ID).source === 'static-pin' && caps.resolveContextWindow(ID).effectiveWindow === 1_000_000)
  check('structured outputs on the home route, never behind a carrier', caps.modelSupportsStructuredOutputs(ID) && !caps.modelSupportsStructuredOutputs('openrouter/anthropic/claude-opus-5-5'))
  caps.resetPerMessageEffortRefusals()
  check('the per-message effort row is not served on the row until the wire is measured to keep the cache under it (Opus 5 folds the same way)', !caps.servesPerMessageEffort(ID) && !caps.servesPerMessageEffort(PREVIOUS) && caps.servesPerMessageEffort('claude-fable-5-1'))
  check("the knowledge cutoff reads 'June 2026' (Opus 5 keeps 'May 2026')", caps.getModelKnowledgeCutoff(ID) === 'June 2026' && caps.getModelKnowledgeCutoff(PREVIOUS) === 'May 2026', `${String(caps.getModelKnowledgeCutoff(ID))} / ${String(caps.getModelKnowledgeCutoff(PREVIOUS))}`)
  const record = caps.resolveModelCapabilities(ID)
  check('the capability record is coherent on the row', record.canonical === ID && record.thinking.adaptive && record.effort.ceiling === 'max' && record.tools.structuredOutputs && record.context.window === 1_000_000 && record.identity.knowledgeCutoff === 'June 2026', JSON.stringify(record))
}

section('§3 the wire laws: thinking always on, no forced tool choice, the four disabled roads omit the parameter, the binding rides, foreign thinking leaves the wire both ways')
{
  const caps = await import('../../src/utils/model/capabilities.ts')
  const { sideQueryThinkingParam } = await import('../../src/utils/sideQuery.ts')
  const { applyThinkingBinding, isSameModel, modelSwitchReceipt } = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
  const { stripThinkingFromOtherModels, thinkingFromOtherModels } = await import('../../src/utils/messages/apiFilters.ts')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf-8')
  const show = (v: unknown): string => JSON.stringify(v)

  check('thinking is always on for the row (the [1m] twin too); Opus 5 keeps its switch; a carrier row never joins', caps.modelThinkingAlwaysOn(ID) && caps.modelThinkingAlwaysOn(`${ID}[1m]`) && !caps.modelThinkingAlwaysOn(PREVIOUS) && !caps.modelThinkingAlwaysOn('openrouter/anthropic/claude-opus-5-5'))
  check('a side query with thinking off sends NO thinking parameter to the row (never the disabled shape)', sideQueryThinkingParam(ID, false, 4096) === undefined && show(sideQueryThinkingParam(PREVIOUS, false, 4096)) === show({ type: 'disabled' }))
  check('a side query with a budget rides adaptive on the row (no budget on the wire)', show(sideQueryThinkingParam(ID, 2048, 4096)) === show({ type: 'adaptive' }) && sideQueryThinkingParam(ID, undefined, 4096) === undefined)
  check('forced tool choice is refused on the row; Opus 5 and a carrier row keep it', !caps.modelSupportsForcedToolChoice(ID) && !caps.modelSupportsForcedToolChoice(`${ID}[1m]`) && caps.modelSupportsForcedToolChoice(PREVIOUS) && caps.modelSupportsForcedToolChoice('openrouter/anthropic/claude-opus-5-5'))
  const forcedTool = { type: 'tool', name: 'classify_result' }
  const forcedAny = { type: 'any' }
  const auto = { type: 'auto' }
  const none = { type: 'none' }
  check("the one fold turns 'tool' and 'any' into auto on the row and leaves auto, none and an absent choice alone", show(caps.foldToolChoiceForModel(ID, forcedTool)) === show({ type: 'auto' }) && show(caps.foldToolChoiceForModel(ID, forcedAny)) === show({ type: 'auto' }) && caps.foldToolChoiceForModel(ID, auto) === auto && caps.foldToolChoiceForModel(ID, none) === none && caps.foldToolChoiceForModel(ID, undefined) === undefined)
  check('the fold leaves Opus 5 verbatim', caps.foldToolChoiceForModel(PREVIOUS, forcedTool) === forcedTool && caps.foldToolChoiceForModel(PREVIOUS, forcedAny) === forcedAny)

  const stream = src('src/services/providers/anthropic/streamCore.ts')
  check('the main stream sends no thinking parameter when the config is disabled (the parameter stays undefined; never the disabled shape)', stream.includes("let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined") && stream.includes('if (hasThinking && modelSupportsThinking(options.model))') && !/thinking\s*=\s*\{\s*type:\s*'disabled'/.test(stream))
  check('the main stream folds the tool choice through the one owner', stream.includes('foldToolChoiceForModel(options.model, options.toolChoice)') && stream.includes('tool_choice: toolChoice,'))
  const roads: Array<[string, RegExp]> = [
    ['src/QueryEngine.ts', /\(\{ type: 'disabled' \} as ThinkingConfig\)/],
    ['src/tools/AgentTool/runAgent.ts', /\{ thinkingConfig: \{ type: 'disabled' as const \} \}/],
    ['src/tools/AgentTool/agentToolUtils.ts', /thinkingConfig: \{ type: 'disabled' \},/],
    ['src/memdir/findRelevantMemories.ts', /thinkingConfig: \{ type: 'disabled' \},/],
  ]
  for (const [rel, shape] of roads) {
    const text = src(rel)
    check(`${rel}: the disabled road is a request CONFIG the main stream translates (never a wire thinking object)`, shape.test(text) && !/thinking:\s*\{\s*type:\s*'disabled'/.test(text))
  }

  const betas: string[] = []
  const bound = applyThinkingBinding({ type: 'adaptive' as const }, betas, { firstParty: () => true, env: undefined })
  check('the preserved-thinking binding rides the row like every first-party request: drop_block and the controls beta', (bound as { block_binding?: { prefix_mismatch_behavior?: string } }).block_binding?.prefix_mismatch_behavior === 'drop_block' && betas.includes('thinking-binding-controls-2026-08-01'), show({ bound, betas }))

  const thinking = { type: 'thinking' as const, thinking: 'a plan', signature: 'sig' }
  const text = (t: string) => ({ type: 'text' as const, text: t, citations: [] })
  const reply = (model: string, id: string) => ({ type: 'assistant' as const, uuid: id, timestamp: '2026-09-22T00:00:00.000Z', message: { id, model, role: 'assistant' as const, type: 'message' as const, content: [thinking, text('done')], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const history = [reply(PREVIOUS, 'msg_opus5'), reply('claude-fable-5-1', 'msg_fable'), reply(ID, 'msg_55'), reply(`${ID}[1m]`, 'msg_55_1m')] as never[]
  const toRow = stripThinkingFromOtherModels(history, ID, isSameModel) as Array<{ message: { id: string; content: Array<{ type: string }> } }>
  const has = (rows: typeof toRow, id: string): boolean => rows.find(r => r.message.id === id)!.message.content.some(b => b.type === 'thinking')
  check("a request to the row carries none of Opus 5's or Fable 5.1's thinking and all of its own (the [1m] twin is the same model)", !has(toRow, 'msg_opus5') && !has(toRow, 'msg_fable') && has(toRow, 'msg_55') && has(toRow, 'msg_55_1m'))
  const toOpus5 = stripThinkingFromOtherModels(history, PREVIOUS, isSameModel) as typeof toRow
  const toFable = stripThinkingFromOtherModels(history, 'claude-fable-5-1', isSameModel) as typeof toRow
  check("the row's thinking leaves a request to Opus 5 and a request to Fable 5.1", !has(toOpus5, 'msg_55') && !has(toOpus5, 'msg_55_1m') && has(toOpus5, 'msg_opus5') && !has(toFable, 'msg_55') && has(toFable, 'msg_fable'))
  const foreign = thinkingFromOtherModels(history, ID, isSameModel)
  check('the foreign count names the two other writers, never the twin', foreign.count === 2 && foreign.models.join(',') === `${PREVIOUS},claude-fable-5-1`, show(foreign))
  const receipt = modelSwitchReceipt('main', history, ID)
  check("the switch receipt keeps its words and names the row 'Opus 5.5'", receipt !== null && receipt.text === `Preserved thinking: 2 thinking blocks written by Opus 5, Fable 5.1 stay out of the requests to Opus 5.5 (the conversation switched models); the model re-plans without them.` && receipt.key === `main|${ID}`, show(receipt))
  const receiptToOpus5 = modelSwitchReceipt('main', [reply(ID, 'msg_a')] as never[], PREVIOUS)
  check("the receipt names the row as a writer the other way", receiptToOpus5 !== null && receiptToOpus5.text.includes('written by Opus 5.5 stay out of the requests to Opus 5'), show(receiptToOpus5))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Opus 5.5 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL OPUS 5.5 ROW PROOFS PASS')
