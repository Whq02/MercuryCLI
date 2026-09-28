#!/usr/bin/env bun
import { mkdtempSync as mkScratch } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as pathJoin } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkScratch(pathJoin(osTmp(), 'sonnet-55-row-proof-'))
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

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}

const ID = 'claude-sonnet-5-5'
const PREVIOUS = 'claude-sonnet-5'

section("§1 the price row: the vendor's tier for claude-sonnet-5-5 is recorded, never a family estimate")
{
  const { calculateUSDCost, getModelPricingString, resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const pricing = resolveModelPricing(ID)
  check('the cost tier is recorded: $2 in, $10 out, $2.50 5m write, $0.20 cache read', pricing.basis === 'recorded' && pricing.costs.inputTokens === 2 && pricing.costs.outputTokens === 10 && pricing.costs.promptCacheWriteTokens === 2.5 && pricing.costs.promptCacheReadTokens === 0.2, JSON.stringify(pricing))
  check("the price string reads '$2/$10 per Mtok'", getModelPricingString(ID) === '$2/$10 per Mtok', String(getModelPricingString(ID)))
  const oneHour = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })
  const fiveMinute = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  const read = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })
  const spent = calculateUSDCost(ID, { input_tokens: 1_000_000, output_tokens: 1_000_000 })
  check('a million 1h-written tokens cost $4, 5m-written $2.50, read $0.20, a million in and out $12', Math.abs(oneHour - 4) < 1e-9 && Math.abs(fiveMinute - 2.5) < 1e-9 && Math.abs(read - 0.2) < 1e-9 && Math.abs(spent - 12) < 1e-9, `${oneHour}/${fiveMinute}/${read}/${spent}`)
  check('the [1m] twin and a case-changed spelling price at the same recorded tier', resolveModelPricing(`${ID}[1m]`).basis === 'recorded' && resolveModelPricing(`${ID}[1m]`).costs.inputTokens === 2 && resolveModelPricing('Claude-Sonnet-5-5').basis === 'recorded', `${resolveModelPricing(`${ID}[1m]`).basis} / ${resolveModelPricing('Claude-Sonnet-5-5').basis}`)
  check('a dated snapshot of the row prices at the same recorded tier', resolveModelPricing('claude-sonnet-5-5-20260928').basis === 'recorded' && resolveModelPricing('claude-sonnet-5-5-20260928').costs.outputTokens === 10, JSON.stringify(resolveModelPricing('claude-sonnet-5-5-20260928')))
  check('a carrier-shaped spelling never reaches the first-party tier', resolveModelPricing('openrouter/anthropic/claude-sonnet-5-5').basis !== 'recorded' || resolveModelPricing('openrouter/anthropic/claude-sonnet-5-5').costs.inputTokens !== 2, JSON.stringify(resolveModelPricing('openrouter/anthropic/claude-sonnet-5-5')))
  check('Sonnet 5 keeps its own recorded row', resolveModelPricing(PREVIOUS).basis === 'recorded', resolveModelPricing(PREVIOUS).basis)
}

section('§2 the fold and the names: claude-sonnet-5-5 is its own canonical, never swallowed by the sonnet-5 arm')
{
  const { firstPartyNameToCanonical, getCanonicalName, getMarketingNameForModel, getPublicModelName, parseUserSpecifiedModel, renderModelChip, renderModelName } = await import('../../src/utils/model/model.ts')
  const { recognizeModelId } = await import('../../src/services/providers/idSpaces.ts')
  check('its own canonical', getCanonicalName(ID) === ID, getCanonicalName(ID))
  check('the [1m] twin folds to the same canonical', getCanonicalName(`${ID}[1m]`) === ID, getCanonicalName(`${ID}[1m]`))
  check('a spelling with case folds to the same canonical', getCanonicalName('Claude-Sonnet-5-5') === ID, getCanonicalName('Claude-Sonnet-5-5'))
  check('the first-party fold agrees', firstPartyNameToCanonical(ID) === ID, firstPartyNameToCanonical(ID))
  check('a dated snapshot of the row folds onto it', getCanonicalName('claude-sonnet-5-5-20260928') === ID, getCanonicalName('claude-sonnet-5-5-20260928'))
  check('Sonnet 5 keeps its own canonical (the previous generation is not the newest)', getCanonicalName(PREVIOUS) === PREVIOUS, getCanonicalName(PREVIOUS))
  check('a dated Sonnet 5 spelling still folds onto Sonnet 5, never onto 5.5', getCanonicalName('claude-sonnet-5-20260401') === PREVIOUS, getCanonicalName('claude-sonnet-5-20260401'))
  check('a carrier-shaped row never joins the first-party fold', getCanonicalName('openrouter/anthropic/claude-sonnet-5-5') === 'openrouter/anthropic/claude-sonnet-5-5')
  check("the one display owner names it 'Sonnet 5.5'", renderModelName(ID) === 'Sonnet 5.5', renderModelName(ID))
  check("the marketing name is 'Sonnet 5.5'", getMarketingNameForModel(ID) === 'Sonnet 5.5', String(getMarketingNameForModel(ID)))
  check("the [1m] twin displays as 'Sonnet 5.5 (1M context)'", renderModelName(`${ID}[1m]`) === 'Sonnet 5.5 (1M context)', renderModelName(`${ID}[1m]`))
  check("the chip reads 'Sonnet 5.5'", renderModelChip(ID) === 'Sonnet 5.5', renderModelChip(ID))
  check("the commit-trailer name reads 'Claude Sonnet 5.5'", getPublicModelName(ID) === 'Claude Sonnet 5.5', getPublicModelName(ID))
  check("Sonnet 5 still displays as 'Sonnet 5'", renderModelName(PREVIOUS) === 'Sonnet 5', renderModelName(PREVIOUS))
  check("the exact-generation alias 'sonnet55' resolves to the bare id", parseUserSpecifiedModel('sonnet55') === ID, parseUserSpecifiedModel('sonnet55'))
  check("'sonnet55[1m]' keeps its rider", parseUserSpecifiedModel('sonnet55[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('sonnet55[1m]'))
  check("the exact-generation alias 'sonnet5' still names Sonnet 5", parseUserSpecifiedModel('sonnet5') === PREVIOUS, parseUserSpecifiedModel('sonnet5'))
  check('the bare id passes through the setting parser byte-identical', parseUserSpecifiedModel(ID) === ID, parseUserSpecifiedModel(ID))
  const recognised = recognizeModelId('sonnet55')
  check("the id space recognises 'sonnet55' as a first-party alias spelling (the sonnet5 shape)", recognised.kind === 'first-party' && recognised.why === 'alias', JSON.stringify(recognised))
  check('the id space recognises the bare id by its claude- mark', recognizeModelId(ID).kind === 'first-party')
}

section("§3 the row: the sonnet family's newest generation, its class, its picker rows, its launch effort and its capability truth")
{
  const { FAMILY_GENERATIONS, newestGenerationKey, previousGenerationKeys } = await import('../../src/utils/model/configs.ts')
  const { getDefaultSonnetModel, parseUserSpecifiedModel, renderModelName, renderModelSetting, renderDefaultModelSetting } = await import('../../src/utils/model/model.ts')
  const { classOfModel } = await import('../../src/utils/router/modelRegistry.ts')
  const { listAnthropicModels, resolveAnthropicModel, routeEffortsFor } = await import('../../src/utils/router/providers/anthropic.ts')
  const { focusedOptionSupports1m, getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
  const { resolveCatalogueSpelling } = await import('../../src/utils/model/modelSpellingFold.ts')
  const effort = await import('../../src/utils/effort.ts')
  const caps = await import('../../src/utils/model/capabilities.ts')
  const { foldLegacyWorkerModelKey } = await import('../../src/services/concourse/workerModels.ts')
  const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')
  const { getModelStrings } = await import('../../src/utils/model/modelStrings.ts')
  const OLDEST = getModelStrings().sonnet46

  check('the generation table lists sonnet55 first, Sonnet 5 second, Sonnet 4.6 third (newest first)', FAMILY_GENERATIONS.sonnet.join(',') === 'sonnet55,sonnet5,sonnet46', FAMILY_GENERATIONS.sonnet.join(','))
  check("newestGenerationKey('sonnet') is sonnet55", newestGenerationKey('sonnet') === 'sonnet55')
  check('the previous generations are Sonnet 5 and Sonnet 4.6 in that order', previousGenerationKeys('sonnet').join(',') === 'sonnet5,sonnet46', previousGenerationKeys('sonnet').join(','))
  check('the family default is the bare id (no env pin)', getDefaultSonnetModel() === ID, getDefaultSonnetModel())
  check("the family word 'sonnet' resolves to it: a saved \"model\": \"sonnet\" runs Sonnet 5.5", parseUserSpecifiedModel('sonnet') === ID, parseUserSpecifiedModel('sonnet'))
  check("'sonnet[1m]' keeps its rider on the new row", parseUserSpecifiedModel('sonnet[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('sonnet[1m]'))
  check("the spoken spellings 'Sonnet 5.5' and 'sonnet-5.5' resolve to the row", parseUserSpecifiedModel('Sonnet 5.5') === ID && parseUserSpecifiedModel('sonnet-5.5') === ID, `${parseUserSpecifiedModel('Sonnet 5.5')} / ${parseUserSpecifiedModel('sonnet-5.5')}`)
  check("the plan alias's mid model is the row", parseUserSpecifiedModel('opusplan') === ID, parseUserSpecifiedModel('opusplan'))
  check("the family word renders capitalised, the default setting renders the row's name", renderModelSetting('sonnet') === 'Sonnet' && renderDefaultModelSetting('sonnet') === 'Sonnet 5.5', `${renderModelSetting('sonnet')} / ${renderDefaultModelSetting('sonnet')}`)
  check("a crew record's 'sonnet' folds to the newest row", foldLegacyWorkerModelKey('sonnet') === ID, foldLegacyWorkerModelKey('sonnet'))

  check("the router classifies the id 'sonnet'", classOfModel(ID) === 'sonnet', String(classOfModel(ID)))
  check("the router classifies the family word 'sonnet'", classOfModel('sonnet') === 'sonnet', String(classOfModel('sonnet')))
  check("the router still classifies Sonnet 5 'sonnet'", classOfModel(PREVIOUS) === 'sonnet', String(classOfModel(PREVIOUS)))
  const adaptive = resolveAnthropicModel('sonnet', 'adaptive')
  const quality = resolveAnthropicModel('sonnet', 'quality')
  check('the seat table resolves the sonnet class to the new row at 1M', adaptive?.model === ID && adaptive.contextWindow === 1_000_000, JSON.stringify(adaptive))
  check("the seat's default efforts per posture are unchanged (high; xhigh on quality)", adaptive?.effort === 'high' && quality?.effort === 'xhigh', `${adaptive?.effort}/${quality?.effort}`)
  check("the seat listing's sonnet row is labelled by the display owner", listAnthropicModels().some(m => m.ref.model === ID && m.displayLabel === 'Sonnet 5.5'), JSON.stringify(listAnthropicModels().map(m => [m.ref.model, m.displayLabel])))
  check('the route ladder reaches max on the row', routeEffortsFor(ID).join(',') === 'high,xhigh,max', routeEffortsFor(ID).join(','))

  const rows = getModelOptions({ anthropicCredentialed: () => true }).filter(o => o.group === undefined)
  const values = rows.map(o => o.value)
  const at = (value: string): number => values.indexOf(value)
  check('the picker lists the new row once, labelled Sonnet 5.5, selectable', rows.filter(o => o.value === ID).length === 1 && rows.find(o => o.value === ID)?.label === 'Sonnet 5.5' && rows.find(o => o.value === ID)?.unavailable === undefined, JSON.stringify(values))
  check('the family alias row dedups onto the explicit row (one model, one row)', !values.includes('sonnet') && !values.includes('sonnet[1m]'), JSON.stringify(values))
  check('Sonnet 5 stays a selectable literal row labelled Sonnet 5', rows.find(o => o.value === PREVIOUS)?.label === 'Sonnet 5' && rows.find(o => o.value === PREVIOUS)?.unavailable === undefined, JSON.stringify(values))
  check("the table's older sonnet generation lists as its own literal row too", rows.find(o => o.value === OLDEST)?.label === renderModelName(OLDEST), JSON.stringify(values))
  check('the sonnet block reads newest first and contiguous: Sonnet 5.5, Sonnet 5, Sonnet 4.6', at(ID) !== -1 && at(PREVIOUS) === at(ID) + 1 && at(OLDEST) === at(PREVIOUS) + 1, JSON.stringify(values))
  check('the newest row leads the block and the block sits before the default Opus (the standard shape)', at(ID) < at(parseUserSpecifiedModel('opus')) && at(OLDEST) + 1 === at(parseUserSpecifiedModel('opus')), JSON.stringify(values))
  check('no sonnet row grows a (1M context) twin: every sonnet row is a bare id', !values.some(v => v.includes('[1m]')), JSON.stringify(values))
  check("the spoken spelling 'sonnet 5.5' resolves to the row and 'sonnet 5' still to Sonnet 5", resolveCatalogueSpelling('sonnet 5.5') === ID && resolveCatalogueSpelling('sonnet 5') === PREVIOUS, `${String(resolveCatalogueSpelling('sonnet 5.5'))} / ${String(resolveCatalogueSpelling('sonnet 5'))}`)
  check('the 1M toggle never lights on the natively-1M rows', !focusedOptionSupports1m(ID) && !focusedOptionSupports1m(PREVIOUS))

  check("the launch effort pins 'high' under the row's own flag", effort.isLaunchEffortPinned(ID) && effort.getLaunchDefaultEffort(ID) === 'high' && effort.getDefaultEffortForModel(ID) === 'high', `${effort.isLaunchEffortPinned(ID)} ${effort.getLaunchDefaultEffort(ID)} ${String(effort.getDefaultEffortForModel(ID))}`)
  const truth = effort.resolveEffortTruth(ID, undefined)
  check("with nothing set the request carries 'high' and the label says so", truth.applied === 'high' && truth.wire === 'high' && truth.label === 'high', JSON.stringify(truth))
  check('the row serves the whole ladder (xhigh and max included)', effort.selectableEffortLevelsForLadder(ID).join(',') === 'low,medium,high,xhigh,max' && caps.getMaxSupportedEffortLevel(ID) === 'max', effort.selectableEffortLevelsForLadder(ID).join(','))
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: { sonnet5: true } }))
  check("unpinning Sonnet 5's launch flag leaves the 5.5 row pinned (its own flag)", effort.isLaunchEffortPinned(ID) && !effort.isLaunchEffortPinned(PREVIOUS))
  effort.unpinAllLaunchEffort()
  check('unpinning every family covers the new flag too', effort.allLaunchEffortUnpinned() && !effort.isLaunchEffortPinned(ID) && (getGlobalConfig() as { launchEffortUnpins?: Record<string, boolean> }).launchEffortUnpins?.sonnet55 === true)
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: {} }))

  check('adaptive thinking, temperature refused, 1M native, 128K out — and the DEFAULT is the stated 128K', caps.modelSupportsAdaptiveThinking(ID) && caps.modelSupportsThinking(ID) && !caps.modelSupportsTemperature(ID) && caps.modelSupports1M(ID) && caps.getContextWindowForModel(ID) === 1_000_000 && caps.getModelMaxOutputTokens(ID).upperLimit === 128_000 && caps.getModelMaxOutputTokens(ID).default === 128_000, JSON.stringify(caps.getModelMaxOutputTokens(ID)))
  check('the context resolution is the first-party static pin', caps.resolveContextWindow(ID).source === 'static-pin' && caps.resolveContextWindow(ID).effectiveWindow === 1_000_000)
  check('structured outputs on the home route, never behind a carrier', caps.modelSupportsStructuredOutputs(ID) && !caps.modelSupportsStructuredOutputs('openrouter/anthropic/claude-sonnet-5-5'))
  caps.resetPerMessageEffortRefusals()
  check('the per-message effort row is not served on the row until the wire is measured to keep the cache under it (Sonnet 5 folds the same way)', !caps.servesPerMessageEffort(ID) && !caps.servesPerMessageEffort(PREVIOUS) && caps.servesPerMessageEffort('claude-fable-5-1'))
  check("the knowledge cutoff reads 'June 2026' (Sonnet 5 keeps none)", caps.getModelKnowledgeCutoff(ID) === 'June 2026' && caps.getModelKnowledgeCutoff(PREVIOUS) === null, `${String(caps.getModelKnowledgeCutoff(ID))} / ${String(caps.getModelKnowledgeCutoff(PREVIOUS))}`)
  const record = caps.resolveModelCapabilities(ID)
  check('the capability record is coherent on the row', record.canonical === ID && record.thinking.adaptive && record.effort.ceiling === 'max' && record.tools.structuredOutputs && record.context.window === 1_000_000 && record.identity.knowledgeCutoff === 'June 2026', JSON.stringify(record))
}

section('§4 the wire laws as the real model answered: thinking always on, no forced tool choice, the disabled roads omit the parameter, foreign thinking leaves the wire both ways')
{
  const caps = await import('../../src/utils/model/capabilities.ts')
  const { sideQueryThinkingParam } = await import('../../src/utils/sideQuery.ts')
  const { isSameModel, modelSwitchReceipt } = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
  const { stripThinkingFromOtherModels, thinkingFromOtherModels } = await import('../../src/utils/messages/apiFilters.ts')
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const src = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf-8')
  const show = (v: unknown): string => JSON.stringify(v)

  check('thinking is always on for the row (the [1m] twin too); Sonnet 5 keeps its switch; a carrier row never joins', caps.modelThinkingAlwaysOn(ID) && caps.modelThinkingAlwaysOn(`${ID}[1m]`) && !caps.modelThinkingAlwaysOn(PREVIOUS) && !caps.modelThinkingAlwaysOn('openrouter/anthropic/claude-sonnet-5-5'))
  check('a side query with thinking off sends NO thinking parameter to the row (never the disabled shape the wire refuses)', sideQueryThinkingParam(ID, false, 4096) === undefined && show(sideQueryThinkingParam(PREVIOUS, false, 4096)) === show({ type: 'disabled' }))
  check('a side query with a budget rides adaptive on the row (no budget on the wire)', show(sideQueryThinkingParam(ID, 2048, 4096)) === show({ type: 'adaptive' }) && sideQueryThinkingParam(ID, undefined, 4096) === undefined)
  check('forced tool choice is refused on the row; Sonnet 5 and a carrier row keep it', !caps.modelSupportsForcedToolChoice(ID) && !caps.modelSupportsForcedToolChoice(`${ID}[1m]`) && caps.modelSupportsForcedToolChoice(PREVIOUS) && caps.modelSupportsForcedToolChoice('openrouter/anthropic/claude-sonnet-5-5'))
  const forcedTool = { type: 'tool', name: 'classify_result' }
  const forcedAny = { type: 'any' }
  const auto = { type: 'auto' }
  const none = { type: 'none' }
  check("the one fold turns 'tool' and 'any' into auto on the row and leaves auto, none and an absent choice alone", show(caps.foldToolChoiceForModel(ID, forcedTool)) === show({ type: 'auto' }) && show(caps.foldToolChoiceForModel(ID, forcedAny)) === show({ type: 'auto' }) && caps.foldToolChoiceForModel(ID, auto) === auto && caps.foldToolChoiceForModel(ID, none) === none && caps.foldToolChoiceForModel(ID, undefined) === undefined)
  check('the fold leaves Sonnet 5 verbatim', caps.foldToolChoiceForModel(PREVIOUS, forcedTool) === forcedTool && caps.foldToolChoiceForModel(PREVIOUS, forcedAny) === forcedAny)
  check('an undeclared sonnet generation answers both laws as the row does (the family head owns them)', caps.modelThinkingAlwaysOn('claude-sonnet-5-7') && !caps.modelSupportsForcedToolChoice('claude-sonnet-5-7'))

  const stream = src('src/services/providers/anthropic/streamCore.ts')
  check('the main stream sends no thinking parameter when the config is disabled (the parameter stays undefined; never the disabled shape)', stream.includes("let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined") && stream.includes('if (hasThinking && modelSupportsThinking(options.model))') && !/thinking\s*=\s*\{\s*type:\s*'disabled'/.test(stream))
  check('the main stream folds the tool choice through the one owner', stream.includes('foldToolChoiceForModel(options.model, options.toolChoice)') && stream.includes('tool_choice: toolChoice,'))

  const thinking = { type: 'thinking' as const, thinking: 'a plan', signature: 'sig' }
  const text = (t: string) => ({ type: 'text' as const, text: t, citations: [] })
  const reply = (model: string, id: string) => ({ type: 'assistant' as const, uuid: id, timestamp: '2026-09-22T00:00:00.000Z', message: { id, model, role: 'assistant' as const, type: 'message' as const, content: [thinking, text('done')], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const history = [reply(PREVIOUS, 'msg_sonnet5'), reply('claude-opus-5-5', 'msg_opus55'), reply(ID, 'msg_55'), reply(`${ID}[1m]`, 'msg_55_1m')] as never[]
  const toRow = stripThinkingFromOtherModels(history, ID, isSameModel) as Array<{ message: { id: string; content: Array<{ type: string }> } }>
  const has = (rows: typeof toRow, id: string): boolean => rows.find(r => r.message.id === id)!.message.content.some(b => b.type === 'thinking')
  check("a request to the row carries none of Sonnet 5's or Opus 5.5's thinking and all of its own (the [1m] twin is the same model)", !has(toRow, 'msg_sonnet5') && !has(toRow, 'msg_opus55') && has(toRow, 'msg_55') && has(toRow, 'msg_55_1m'))
  const toSonnet5 = stripThinkingFromOtherModels(history, PREVIOUS, isSameModel) as typeof toRow
  check("the row's thinking leaves a request to Sonnet 5", !has(toSonnet5, 'msg_55') && !has(toSonnet5, 'msg_55_1m') && has(toSonnet5, 'msg_sonnet5'))
  const foreign = thinkingFromOtherModels(history, ID, isSameModel)
  check('the foreign count names the two other writers, never the twin', foreign.count === 2 && foreign.models.join(',') === `${PREVIOUS},claude-opus-5-5`, show(foreign))
  const receipt = modelSwitchReceipt('main', history, ID)
  check("the switch receipt names the row 'Sonnet 5.5'", receipt !== null && receipt.text.includes('stay out of the requests to Sonnet 5.5') && receipt.key === `main|${ID}`, show(receipt))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Sonnet 5.5 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL SONNET 5.5 ROW PROOFS PASS')
