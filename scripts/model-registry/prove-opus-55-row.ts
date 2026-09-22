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

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Opus 5.5 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL OPUS 5.5 ROW PROOFS PASS')
