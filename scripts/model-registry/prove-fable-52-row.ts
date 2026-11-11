#!/usr/bin/env bun
import { mkdtempSync as mkScratch } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as pathJoin } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkScratch(pathJoin(osTmp(), 'fable-52-row-proof-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = proofHome
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY']) delete process.env[key]
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
  'MERCURY_EFFORT_LEVEL',
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

const ID = 'claude-fable-5-2'
const MIRROR = 'claude-mythos-5-2'
const PREVIOUS = 'claude-fable-5-1'
const OLDEST = 'claude-fable-5'
const DATED = 'claude-fable-5-2-20261109'
const CARRIER = 'openrouter/anthropic/claude-fable-5-2'
const UNDECLARED = 'claude-fable-5-7'

section("§1 the price row: the vendor's tier for claude-fable-5-2 is recorded, never the Fable 5.1 estimate")
{
  const { calculateUSDCost, getModelPricingString, resolveModelPricing, ANTHROPIC_PRICE_OBSERVED_AT } = await import('../../src/utils/modelCost.ts')
  const pricing = resolveModelPricing(ID)
  check('the cost tier is recorded: $8 in, $40 out, $10 5m write, $0.20 cache read (0.025x; platform.claude.com/docs/en/about-claude/pricing read 2026-11-09)', pricing.basis === 'recorded' && pricing.costs.inputTokens === 8 && pricing.costs.outputTokens === 40 && pricing.costs.promptCacheWriteTokens === 10 && pricing.costs.promptCacheReadTokens === 0.2, JSON.stringify(pricing))
  check("the price string reads '$8/$40 per Mtok'", getModelPricingString(ID) === '$8/$40 per Mtok', String(getModelPricingString(ID)))
  const oneHour = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } })
  const fiveMinute = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })
  const read = calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })
  const spent = calculateUSDCost(ID, { input_tokens: 1_000_000, output_tokens: 1_000_000 })
  check('a million 1h-written tokens cost $16, 5m-written $10, read $0.20, a million in and out $48', Math.abs(oneHour - 16) < 1e-9 && Math.abs(fiveMinute - 10) < 1e-9 && Math.abs(read - 0.2) < 1e-9 && Math.abs(spent - 48) < 1e-9, `${oneHour}/${fiveMinute}/${read}/${spent}`)
  check('the [1m] twin and a case-changed spelling price at the same recorded tier', resolveModelPricing(`${ID}[1m]`).basis === 'recorded' && resolveModelPricing(`${ID}[1m]`).costs.inputTokens === 8 && resolveModelPricing('Claude-Fable-5-2').basis === 'recorded', `${resolveModelPricing(`${ID}[1m]`).basis} / ${resolveModelPricing('Claude-Fable-5-2').basis}`)
  check('a dated snapshot of the row prices at the same recorded tier', resolveModelPricing(DATED).basis === 'recorded' && resolveModelPricing(DATED).costs.outputTokens === 40, JSON.stringify(resolveModelPricing(DATED)))
  check("the Mythos 5.2 mirror prices at the row's tier (the vendor's page: same specifications and pricing)", resolveModelPricing(MIRROR).basis === 'recorded' && resolveModelPricing(MIRROR).costs.inputTokens === 8 && resolveModelPricing(MIRROR).costs.promptCacheReadTokens === 0.2, JSON.stringify(resolveModelPricing(MIRROR)))
  check('a carrier-shaped spelling never reaches the first-party tier', resolveModelPricing(CARRIER).basis !== 'recorded' || resolveModelPricing(CARRIER).costs.inputTokens !== 8, JSON.stringify(resolveModelPricing(CARRIER)))
  check("Fable 5.1 keeps its own recorded row: $10/$50 with the $0.25 read", resolveModelPricing(PREVIOUS).basis === 'recorded' && resolveModelPricing(PREVIOUS).costs.inputTokens === 10 && resolveModelPricing(PREVIOUS).costs.outputTokens === 50 && resolveModelPricing(PREVIOUS).costs.promptCacheReadTokens === 0.25 && getModelPricingString(PREVIOUS) === '$10/$50 per Mtok', JSON.stringify(resolveModelPricing(PREVIOUS)))
  check('an undeclared fable generation is estimated from the new head and says so', resolveModelPricing(UNDECLARED).basis === 'family-estimate' && resolveModelPricing(UNDECLARED).costs.inputTokens === 8, JSON.stringify(resolveModelPricing(UNDECLARED)))
  check('the observation is dated the day the pricing page was read', ANTHROPIC_PRICE_OBSERVED_AT[ID]?.observedAt === '2026-11-09', JSON.stringify(ANTHROPIC_PRICE_OBSERVED_AT[ID]))
}

section('§2 the fold and the names: claude-fable-5-2 is its own canonical, never swallowed by the fable-5 arm or the Fable 5.1 row')
{
  const { firstPartyNameToCanonical, getCanonicalName, getMarketingNameForModel, getPublicModelName, parseUserSpecifiedModel, renderModelChip, renderModelName } = await import('../../src/utils/model/model.ts')
  const { recognizeModelId } = await import('../../src/services/providers/idSpaces.ts')
  const { ALL_MODEL_CONFIGS } = await import('../../src/utils/model/configs.ts')
  check('its own canonical', getCanonicalName(ID) === ID, getCanonicalName(ID))
  check('the [1m] twin folds to the same canonical', getCanonicalName(`${ID}[1m]`) === ID, getCanonicalName(`${ID}[1m]`))
  check('a spelling with case folds to the same canonical', getCanonicalName('Claude-Fable-5-2') === ID, getCanonicalName('Claude-Fable-5-2'))
  check('the first-party fold agrees', firstPartyNameToCanonical(ID) === ID, firstPartyNameToCanonical(ID))
  check('a dated snapshot of the row folds onto it', getCanonicalName(DATED) === ID, getCanonicalName(DATED))
  check('the Mythos 5.2 mirror folds onto it, and its row names the page it was read from', getCanonicalName(MIRROR) === ID && ALL_MODEL_CONFIGS.mythos52.canonical === ID && ALL_MODEL_CONFIGS.mythos52.observedAt === '2026-11-09' && ALL_MODEL_CONFIGS.mythos52.source === 'https://platform.claude.com/docs/en/models/mythos-5-2/overview', `${getCanonicalName(MIRROR)} ${JSON.stringify(ALL_MODEL_CONFIGS.mythos52)}`)
  check('Fable 5.1 and the Mythos 5.1 mirror keep their own canonical (the previous generation is not the newest)', getCanonicalName(PREVIOUS) === PREVIOUS && getCanonicalName('claude-mythos-5-1') === PREVIOUS, `${getCanonicalName(PREVIOUS)} / ${getCanonicalName('claude-mythos-5-1')}`)
  check('a dated Fable 5.1 spelling still folds onto Fable 5.1, never onto 5.2', getCanonicalName('claude-fable-5-1-20260401') === PREVIOUS, getCanonicalName('claude-fable-5-1-20260401'))
  check('Fable 5 keeps its own canonical', getCanonicalName(OLDEST) === OLDEST, getCanonicalName(OLDEST))
  check('a carrier-shaped row never joins the first-party fold', getCanonicalName(CARRIER) === CARRIER)
  check("the one display owner names it 'Fable 5.2'", renderModelName(ID) === 'Fable 5.2', renderModelName(ID))
  check("the marketing name is 'Fable 5.2'", getMarketingNameForModel(ID) === 'Fable 5.2', String(getMarketingNameForModel(ID)))
  check("the [1m] twin displays as 'Fable 5.2 (1M context)'", renderModelName(`${ID}[1m]`) === 'Fable 5.2 (1M context)', renderModelName(`${ID}[1m]`))
  check("the chip reads 'Fable 5.2'", renderModelChip(ID) === 'Fable 5.2', renderModelChip(ID))
  check("the commit-trailer name reads 'Claude Fable 5.2'", getPublicModelName(ID) === 'Claude Fable 5.2', getPublicModelName(ID))
  check("Fable 5.1 still displays as 'Fable 5.1' and Fable 5 as 'Fable 5'", renderModelName(PREVIOUS) === 'Fable 5.1' && renderModelName(OLDEST) === 'Fable 5', `${renderModelName(PREVIOUS)} / ${renderModelName(OLDEST)}`)
  const { MODEL_NAMES } = (await import(pathJoin(import.meta.dir, '..', '..', 'assets', 'splash', 'splash-core.mjs'))) as { MODEL_NAMES: Record<string, string> }
  check("the boot strip's baked table names the row, and a saved 'fable' paints what it boots", MODEL_NAMES[ID] === 'Fable 5.2' && MODEL_NAMES.fable52 === 'Fable 5.2' && MODEL_NAMES.fable === getMarketingNameForModel(parseUserSpecifiedModel('fable')) && MODEL_NAMES[PREVIOUS] === 'Fable 5.1' && MODEL_NAMES.fable51 === 'Fable 5.1', `${String(MODEL_NAMES[ID])} / ${String(MODEL_NAMES.fable)} / ${String(MODEL_NAMES[PREVIOUS])}`)
  check("the word 'mythos' names the row's mirror, the counterpart of what 'fable' names, and 'mythos[1m]' keeps its rider", parseUserSpecifiedModel('mythos') === MIRROR && getCanonicalName(parseUserSpecifiedModel('mythos')) === parseUserSpecifiedModel('fable') && parseUserSpecifiedModel('mythos[1m]') === `${MIRROR}[1m]`, `${parseUserSpecifiedModel('mythos')} / ${parseUserSpecifiedModel('mythos[1m]')}`)
  check("the mirror displays as 'Mythos 5.2' and its [1m] twin as 'Mythos 5.2 (1M context)', as the row's does", renderModelName(MIRROR) === 'Mythos 5.2' && renderModelName(`${MIRROR}[1m]`) === 'Mythos 5.2 (1M context)' && renderModelName('claude-mythos-5-1[1m]') === 'Mythos 5.1 (1M context)', `${renderModelName(MIRROR)} / ${renderModelName(`${MIRROR}[1m]`)} / ${renderModelName('claude-mythos-5-1[1m]')}`)
  check("the boot strip's baked table names the mirror, and a saved 'mythos' paints what it boots", MODEL_NAMES[MIRROR] === 'Mythos 5.2' && MODEL_NAMES.mythos === 'Mythos 5.2' && MODEL_NAMES.mythos === getMarketingNameForModel(parseUserSpecifiedModel('mythos')), `${String(MODEL_NAMES[MIRROR])} / ${String(MODEL_NAMES.mythos)}`)
  check("the exact-generation alias 'fable52' resolves to the bare id", parseUserSpecifiedModel('fable52') === ID, parseUserSpecifiedModel('fable52'))
  check("'fable52[1m]' keeps its rider", parseUserSpecifiedModel('fable52[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('fable52[1m]'))
  check("the exact-generation alias 'fable51' still names Fable 5.1", parseUserSpecifiedModel('fable51') === PREVIOUS, parseUserSpecifiedModel('fable51'))
  check('the bare id passes through the setting parser byte-identical', parseUserSpecifiedModel(ID) === ID, parseUserSpecifiedModel(ID))
  const recognised = recognizeModelId('fable52')
  check("the id space recognises 'fable52' as a first-party alias spelling (the fable51 shape)", recognised.kind === 'first-party' && recognised.why === 'alias', JSON.stringify(recognised))
  check('the id space recognises the bare id by its claude- mark', recognizeModelId(ID).kind === 'first-party')
}

section("§3 the row: the fable family's newest generation, its class, its picker rows, its launch effort and its capability truth")
{
  const { FAMILY_GENERATIONS, familyHeadOf, newestGenerationKey, previousGenerationKeys } = await import('../../src/utils/model/configs.ts')
  const { getDefaultFableModel, parseUserSpecifiedModel, renderModelSetting, renderDefaultModelSetting } = await import('../../src/utils/model/model.ts')
  const { AGENT_DISPATCH_MODELS, MODEL_ALIASES } = await import('../../src/utils/model/aliases.ts')
  const { classOfModel } = await import('../../src/services/providers/modelRegistry.ts')
  const { listAnthropicModels, resolveAnthropicModel, routeEffortsFor } = await import('../../src/services/providers/anthropic/anthropicAdapter.ts')
  const { focusedOptionSupports1m, getModelOptions } = await import('../../src/utils/model/modelOptions.ts')
  const { resolveCatalogueSpelling } = await import('../../src/utils/model/modelSpellingFold.ts')
  const effort = await import('../../src/utils/effort.ts')
  const caps = await import('../../src/utils/model/capabilities.ts')
  const { foldLegacyWorkerModelKey } = await import('../../src/services/concourse/workerModels.ts')
  const { _firstPartyFrontierMemberForTest } = await import('../../src/services/capFailover.ts')
  const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')

  check('the generation table lists fable52 first, Fable 5.1 second, Fable 5 third (newest first)', FAMILY_GENERATIONS.fable.join(',') === 'fable52,fable51,fable5', FAMILY_GENERATIONS.fable.join(','))
  check("newestGenerationKey('fable') is fable52", newestGenerationKey('fable') === 'fable52')
  check('the previous generations are Fable 5.1 and Fable 5 in that order', previousGenerationKeys('fable').join(',') === 'fable51,fable5', previousGenerationKeys('fable').join(','))
  check('the family default is the bare id (no env pin)', getDefaultFableModel() === ID, getDefaultFableModel())
  check("the family word 'fable' resolves to it: a saved \"model\": \"fable\" runs Fable 5.2", parseUserSpecifiedModel('fable') === ID, parseUserSpecifiedModel('fable'))
  check("'fable[1m]' keeps its rider on the new row", parseUserSpecifiedModel('fable[1m]') === `${ID}[1m]`, parseUserSpecifiedModel('fable[1m]'))
  check("the spoken spellings 'Fable 5.2' and 'fable-5.2' resolve to the row", parseUserSpecifiedModel('Fable 5.2') === ID && parseUserSpecifiedModel('fable-5.2') === ID, `${parseUserSpecifiedModel('Fable 5.2')} / ${parseUserSpecifiedModel('fable-5.2')}`)
  check("the family word renders capitalised, the default setting renders the row's name", renderModelSetting('fable') === 'Fable' && renderDefaultModelSetting('fable') === 'Fable 5.2', `${renderModelSetting('fable')} / ${renderDefaultModelSetting('fable')}`)
  check("the settings alias list and the dispatch vocabulary carry 'fable52' beside 'fable51'", (MODEL_ALIASES as readonly string[]).includes('fable52') && (MODEL_ALIASES as readonly string[]).includes('fable51') && (AGENT_DISPATCH_MODELS as readonly string[]).includes('fable52'))
  check("a crew record's 'fable' folds to the newest row while its 'fable51' stays on Fable 5.1", foldLegacyWorkerModelKey('fable') === ID && foldLegacyWorkerModelKey('fable51') === PREVIOUS, `${foldLegacyWorkerModelKey('fable')} / ${foldLegacyWorkerModelKey('fable51')}`)
  check('the cap handoff ranks the row as the newest first-party frontier member', _firstPartyFrontierMemberForTest('fallback') === ID, _firstPartyFrontierMemberForTest('fallback'))
  check('a declared row has no family head; an undeclared fable generation takes this row as its head', familyHeadOf(ID) === null && familyHeadOf(UNDECLARED) === 'fable52', `${String(familyHeadOf(ID))} / ${String(familyHeadOf(UNDECLARED))}`)

  check("the router classifies the id 'fable'", classOfModel(ID) === 'fable', String(classOfModel(ID)))
  check("the router classifies the family word 'fable'", classOfModel('fable') === 'fable', String(classOfModel('fable')))
  check("the router still classifies Fable 5.1 and Fable 5 'fable'", classOfModel(PREVIOUS) === 'fable' && classOfModel(OLDEST) === 'fable', `${String(classOfModel(PREVIOUS))} / ${String(classOfModel(OLDEST))}`)
  const seat = resolveAnthropicModel('fable')
  check('the seat table resolves the fable class to the new row at 1M with no [1m] rider', seat?.model === ID && seat.contextWindow === 1_000_000, JSON.stringify(seat))
  check("the seat's default effort is unchanged (high)", seat?.effort === 'high', String(seat?.effort))
  check("the seat listing's fable row is labelled by the display owner", listAnthropicModels().some(m => m.ref.model === ID && m.displayLabel === 'Fable 5.2'), JSON.stringify(listAnthropicModels().map(m => [m.ref.model, m.displayLabel])))
  check('the route ladder reaches max on the row', routeEffortsFor(ID).join(',') === 'high,xhigh,max', routeEffortsFor(ID).join(','))

  const rows = getModelOptions({ anthropicCredentialed: () => true }).filter(o => o.group === undefined)
  const values = rows.map(o => o.value)
  const at = (value: string): number => values.indexOf(value)
  check('the picker lists the new row once, labelled Fable 5.2, selectable', rows.filter(o => o.value === ID).length === 1 && rows.find(o => o.value === ID)?.label === 'Fable 5.2' && rows.find(o => o.value === ID)?.unavailable === undefined, JSON.stringify(values))
  check('the family alias row dedups onto the explicit row (one model, one row)', !values.includes('fable') && !values.includes('fable[1m]'), JSON.stringify(values))
  check('Fable 5.1 and Fable 5 stay selectable literal rows under their own names', rows.find(o => o.value === PREVIOUS)?.label === 'Fable 5.1' && rows.find(o => o.value === PREVIOUS)?.unavailable === undefined && rows.find(o => o.value === OLDEST)?.label === 'Fable 5', JSON.stringify(values))
  check('the fable block leads the section, newest first and contiguous: Fable 5.2, Fable 5.1, Fable 5', at(ID) === 0 && at(PREVIOUS) === 1 && at(OLDEST) === 2, JSON.stringify(values))
  check("the spoken spelling 'fable 5.2' resolves to the row, 'fable 5.1' still to Fable 5.1 and 'fable 5' to Fable 5", resolveCatalogueSpelling('fable 5.2') === ID && resolveCatalogueSpelling('fable 5.1') === PREVIOUS && resolveCatalogueSpelling('fable 5') === OLDEST, `${String(resolveCatalogueSpelling('fable 5.2'))} / ${String(resolveCatalogueSpelling('fable 5.1'))} / ${String(resolveCatalogueSpelling('fable 5'))}`)
  check('the 1M toggle never lights on the natively-1M row', !focusedOptionSupports1m(ID))

  check("the launch effort pins 'high' under the row's own flag (the vendor's default for the row)", effort.isLaunchEffortPinned(ID) && effort.getLaunchDefaultEffort(ID) === 'high' && effort.getDefaultEffortForModel(ID) === 'high', `${effort.isLaunchEffortPinned(ID)} ${effort.getLaunchDefaultEffort(ID)} ${String(effort.getDefaultEffortForModel(ID))}`)
  const truth = effort.resolveEffortTruth(ID, undefined)
  check("with nothing set the request carries 'high' and the label says so", truth.applied === 'high' && truth.wire === 'high' && truth.label === 'high', JSON.stringify(truth))
  const mirrored = [MIRROR, `${MIRROR}[1m]`, 'claude-mythos-5-2-20261109'].map(id => `${id} ${effort.isLaunchEffortPinned(id)} ${effort.resolveEffortTruth(id, undefined).wire}`)
  check("the Mythos 5.2 mirror takes the row's launch effort under the row's flag (the vendor: the same specifications, default effort high): pinned and 'high' on the wire with nothing set, its [1m] twin and a dated snapshot too", mirrored.every(row => row.endsWith(' true high')) && effort.getDefaultEffortForModel(MIRROR) === 'high', mirrored.join(' · '))
  check('a dated Mythos 5 spelling whose date begins with 2 is not this mirror: it answers the launch flag as Mythos 5 does', effort.isLaunchEffortPinned('claude-mythos-5-20260401') === effort.isLaunchEffortPinned('claude-mythos-5') && effort.resolveEffortTruth('claude-mythos-5-20260401', undefined).wire === effort.resolveEffortTruth('claude-mythos-5', undefined).wire, `${effort.isLaunchEffortPinned('claude-mythos-5-20260401')} ${String(effort.resolveEffortTruth('claude-mythos-5-20260401', undefined).wire)}`)
  check('the row serves the whole ladder (xhigh and max included)', effort.selectableEffortLevelsForLadder(ID).join(',') === 'low,medium,high,xhigh,max' && caps.getMaxSupportedEffortLevel(ID) === 'max', effort.selectableEffortLevelsForLadder(ID).join(','))
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: { fable51: true, fable5: true } }))
  check("unpinning Fable 5.1's and Fable 5's launch flags leaves the 5.2 row and its mirror pinned (their own flag)", effort.isLaunchEffortPinned(ID) && effort.isLaunchEffortPinned(MIRROR) && !effort.isLaunchEffortPinned(PREVIOUS) && !effort.isLaunchEffortPinned(OLDEST))
  check("a dated Fable 5 spelling whose date begins with 2 answers as Fable 5, never as this row: its own launch flag and its own cutoff", !effort.isLaunchEffortPinned('claude-fable-5-20260401') && caps.getModelKnowledgeCutoff('claude-fable-5-20260401') === 'January 2026' && effort.isLaunchEffortPinned(DATED) && caps.getModelKnowledgeCutoff(DATED) === 'June 2026', `${effort.isLaunchEffortPinned('claude-fable-5-20260401')} ${String(caps.getModelKnowledgeCutoff('claude-fable-5-20260401'))} / ${effort.isLaunchEffortPinned(DATED)} ${String(caps.getModelKnowledgeCutoff(DATED))}`)
  effort.unpinAllLaunchEffort()
  check('unpinning every family covers the new flag too, and the mirror follows it', effort.allLaunchEffortUnpinned() && !effort.isLaunchEffortPinned(ID) && !effort.isLaunchEffortPinned(MIRROR) && (getGlobalConfig() as { launchEffortUnpins?: Record<string, boolean> }).launchEffortUnpins?.fable52 === true)
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: {} }))

  check('adaptive thinking, temperature refused, 1M native, 128K out — and the DEFAULT is the stated 128K', caps.modelSupportsAdaptiveThinking(ID) && caps.modelSupportsThinking(ID) && !caps.modelSupportsTemperature(ID) && caps.modelSupports1M(ID) && caps.getContextWindowForModel(ID) === 1_000_000 && caps.getModelMaxOutputTokens(ID).upperLimit === 128_000 && caps.getModelMaxOutputTokens(ID).default === 128_000, JSON.stringify(caps.getModelMaxOutputTokens(ID)))
  check('the context resolution is the first-party static pin, on the mirror too', caps.resolveContextWindow(ID).source === 'static-pin' && caps.resolveContextWindow(ID).effectiveWindow === 1_000_000 && caps.resolveContextWindow(MIRROR).effectiveWindow === 1_000_000)
  check('structured outputs on the home route, never behind a carrier', caps.modelSupportsStructuredOutputs(ID) && !caps.modelSupportsStructuredOutputs(CARRIER))
  check("the knowledge cutoff reads 'June 2026' on the row and its mirror; Fable 5 keeps 'January 2026'; an undeclared generation states none", caps.getModelKnowledgeCutoff(ID) === 'June 2026' && caps.getModelKnowledgeCutoff(MIRROR) === 'June 2026' && caps.getModelKnowledgeCutoff(OLDEST) === 'January 2026' && caps.getModelKnowledgeCutoff(UNDECLARED) === null, `${String(caps.getModelKnowledgeCutoff(ID))} / ${String(caps.getModelKnowledgeCutoff(MIRROR))} / ${String(caps.getModelKnowledgeCutoff(OLDEST))} / ${String(caps.getModelKnowledgeCutoff(UNDECLARED))}`)
  const record = caps.resolveModelCapabilities(ID)
  check('the capability record is coherent on the row', record.canonical === ID && record.thinking.adaptive && record.effort.ceiling === 'max' && record.tools.structuredOutputs && record.context.window === 1_000_000 && record.identity.knowledgeCutoff === 'June 2026', JSON.stringify(record))
}

section('§4 the wire laws the vendor states for the row: thinking always on, no forced tool choice, the disabled road omits the parameter, foreign thinking leaves the wire both ways')
{
  const caps = await import('../../src/utils/model/capabilities.ts')
  const { sideQueryThinkingParam } = await import('../../src/utils/sideQuery.ts')
  const { describeInputTransformations, isSameModel, modelSwitchReceipt } = await import('../../src/services/providers/anthropic/thinkingBinding.ts')
  const { stripThinkingFromOtherModels, thinkingFromOtherModels } = await import('../../src/utils/messages/apiFilters.ts')
  const show = (v: unknown): string => JSON.stringify(v)

  check('thinking is always on for the row, its [1m] twin and its mirror; a carrier row never joins', caps.modelThinkingAlwaysOn(ID) && caps.modelThinkingAlwaysOn(`${ID}[1m]`) && caps.modelThinkingAlwaysOn(MIRROR) && !caps.modelThinkingAlwaysOn(CARRIER))
  check('a side query with thinking off sends NO thinking parameter to the row (never the disabled shape the wire refuses)', sideQueryThinkingParam(ID, false, 4096) === undefined)
  check('a side query with a budget rides adaptive on the row (no budget on the wire)', show(sideQueryThinkingParam(ID, 2048, 4096)) === show({ type: 'adaptive' }) && sideQueryThinkingParam(ID, undefined, 4096) === undefined)
  check('forced tool choice is refused on the row, its twin and its mirror; Fable 5 and a carrier row keep it', !caps.modelSupportsForcedToolChoice(ID) && !caps.modelSupportsForcedToolChoice(`${ID}[1m]`) && !caps.modelSupportsForcedToolChoice(MIRROR) && caps.modelSupportsForcedToolChoice(OLDEST) && caps.modelSupportsForcedToolChoice(CARRIER))
  const forcedTool = { type: 'tool', name: 'classify_result' }
  const forcedAny = { type: 'any' }
  const auto = { type: 'auto' }
  const none = { type: 'none' }
  check("the one fold turns 'tool' and 'any' into auto on the row and leaves auto, none and an absent choice alone", show(caps.foldToolChoiceForModel(ID, forcedTool)) === show({ type: 'auto' }) && show(caps.foldToolChoiceForModel(ID, forcedAny)) === show({ type: 'auto' }) && caps.foldToolChoiceForModel(ID, auto) === auto && caps.foldToolChoiceForModel(ID, none) === none && caps.foldToolChoiceForModel(ID, undefined) === undefined)
  check('an undeclared fable generation answers both laws as the row does (the family head owns them)', caps.modelThinkingAlwaysOn(UNDECLARED) && !caps.modelSupportsForcedToolChoice(UNDECLARED))

  const thinking = { type: 'thinking' as const, thinking: 'a plan', signature: 'sig' }
  const text = (t: string) => ({ type: 'text' as const, text: t, citations: [] })
  const reply = (model: string, id: string) => ({ type: 'assistant' as const, uuid: id, timestamp: '2026-11-09T00:00:00.000Z', message: { id, model, role: 'assistant' as const, type: 'message' as const, content: [thinking, text('done')], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
  const history = [reply(PREVIOUS, 'msg_fable51'), reply('claude-opus-5-5', 'msg_opus55'), reply(ID, 'msg_52'), reply(`${ID}[1m]`, 'msg_52_1m'), reply(MIRROR, 'msg_mythos52')] as never[]
  check('the row, its [1m] twin and its mirror are one model to the thinking law; Fable 5.1 is another', isSameModel(ID, `${ID}[1m]`) && isSameModel(ID, MIRROR) && !isSameModel(ID, PREVIOUS))
  const toRow = stripThinkingFromOtherModels(history, ID, isSameModel) as Array<{ message: { id: string; content: Array<{ type: string }> } }>
  const has = (rows: typeof toRow, id: string): boolean => rows.find(r => r.message.id === id)!.message.content.some(b => b.type === 'thinking')
  check("a request to the row carries none of Fable 5.1's or Opus 5.5's thinking and all of its own, its twin's and its mirror's", !has(toRow, 'msg_fable51') && !has(toRow, 'msg_opus55') && has(toRow, 'msg_52') && has(toRow, 'msg_52_1m') && has(toRow, 'msg_mythos52'))
  const toPrevious = stripThinkingFromOtherModels(history, PREVIOUS, isSameModel) as typeof toRow
  check("the row's thinking leaves a request to Fable 5.1 (the vendor: only Fable 5.2 and Mythos 5.2 read it)", !has(toPrevious, 'msg_52') && !has(toPrevious, 'msg_52_1m') && !has(toPrevious, 'msg_mythos52') && has(toPrevious, 'msg_fable51'))
  const foreign = thinkingFromOtherModels(history, ID, isSameModel)
  check('the foreign count names the two other writers, never the twin or the mirror', foreign.count === 2 && foreign.models.join(',') === `${PREVIOUS},claude-opus-5-5`, show(foreign))
  const receipt = modelSwitchReceipt('main', history.slice(0, 2) as never[], ID)
  check("the switch receipt names the row 'Fable 5.2'", receipt !== null && receipt.text.includes('stay out of the requests to Fable 5.2') && receipt.key === `main|msg_opus55|${ID}`, show(receipt))
  check('once the row has answered, a request to it is no switch (the twin and the mirror included)', modelSwitchReceipt('main', history, ID) === null)
  const { applyThinkingDisplay } = await import('../../src/services/providers/anthropic/thinkingDisplay.ts')
  const DISPLAY_BETA = 'thinking-display-updates-2026-08-18'
  const asked: string[] = []
  const withUpdates = applyThinkingDisplay(ID, { type: 'adaptive' }, asked, { env: 'updates', firstParty: () => true })
  check("the row's notes between tool calls arrive as progress-update thinking blocks: asked for, the request carries display 'updates' under its beta", caps.modelNarratesInThinkingBlocks(ID) && caps.modelNarratesInThinkingBlocks(MIRROR) && show(withUpdates) === show({ type: 'adaptive', display: 'updates' }) && asked.includes(DISPLAY_BETA), `${show(withUpdates)} ${asked.join(',')}`)
  const unasked: string[] = []
  check('unasked, the display field and its beta stay off the row as they do on Opus 5.5 (the standing default)', show(applyThinkingDisplay(ID, { type: 'adaptive' }, unasked, { env: undefined, firstParty: () => true })) === show({ type: 'adaptive' }) && unasked.length === 0, unasked.join(','))
  const carried: string[] = []
  check("a carrier-shaped spelling of the row stays outside the display gate even when asked (the beta is the home route's)", !caps.modelNarratesInThinkingBlocks(CARRIER) && show(applyThinkingDisplay(CARRIER, { type: 'adaptive' }, carried, { env: 'updates', firstParty: () => true })) === show({ type: 'adaptive' }) && carried.length === 0, carried.join(','))
  const otherAccount = describeInputTransformations([{ type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'organization_binding_mismatch' }])
  check("a drop the provider attributes to another account is said as that: the row's thinking stays with the account that wrote it", otherAccount !== null && otherAccount.includes('another account') && !otherAccount.includes('client-side edit'), String(otherAccount))
}

section('§5 the docs say what the family word means and which facts the row carries')
{
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const doc = (rel: string): string => readFileSync(join(import.meta.dir, '..', '..', rel), 'utf-8')
  const engines = doc('docs/ENGINES.md')
  const sessions = doc('docs/SESSIONS.md')
  check('ENGINES.md: the family word means the new row and both exact-generation aliases are named', engines.includes('`fable` means Fable 5.2 (`claude-fable-5-2`); `fable52` names that generation\nexplicitly and `fable51` still names Fable 5.1.') && engines.includes('`fable` · `fable51` · `fable52`'))
  check('ENGINES.md: the row\'s window, output, thinking, effort default and tool-choice law, in words', engines.includes('has a native 1M context window, 128K output and adaptive thinking that is\nalways on') && engines.includes('effort choice it uses the documented `high` default. A forced tool choice\nbecomes `auto`'))
  check('ENGINES.md: the prices as read, with the day', engines.includes('$8\ninput and $40 output, $10 for a five-minute cache write, $16 for a one-hour\ncache write and $0.20 for a cache read') && engines.includes('read on 2026-11-09.'))
  check('ENGINES.md: who reads its thinking, the account it stays with, and the Mythos counterpart', engines.includes('Its thinking blocks are read by Fable\n5.2 and Mythos 5.2 alone: after a switch to another model they stay out of\nthat model\'s requests') && engines.includes('They stay with the account\nthat wrote them too') && engines.includes('`claude-mythos-5-2`\nresolves as Fable 5.2\'s counterpart'))
  check("ENGINES.md: what the word 'mythos' means, and the row a listed Mythos id gets with the four facts it shares", engines.includes('facts and prices, and `mythos` means Mythos 5.2. These are the') && engines.includes("a listed Mythos id gets its own row under its\nFable counterpart, named, selectable and served with that counterpart's\nwindow, effort levels, launch effort and prices."))
  const { resolveModelPricing } = await import('../../src/utils/modelCost.ts')
  const { getContextWindowForModel } = await import('../../src/utils/model/capabilities.ts')
  const { getLaunchDefaultEffort, isLaunchEffortPinned, selectableEffortLevelsForLadder } = await import('../../src/utils/effort.ts')
  const { CANONICAL_MODEL_IDS, mirrorTwinOf } = await import('../../src/utils/model/configs.ts')
  const mirrors = CANONICAL_MODEL_IDS.filter(id => mirrorTwinOf(id) !== undefined)
  const sharesTheFour = (id: string): boolean => {
    const twin = mirrorTwinOf(id) ?? ''
    return (
      getContextWindowForModel(id) === getContextWindowForModel(twin) &&
      selectableEffortLevelsForLadder(id).join(',') === selectableEffortLevelsForLadder(twin).join(',') &&
      isLaunchEffortPinned(id) === isLaunchEffortPinned(twin) &&
      getLaunchDefaultEffort(id) === getLaunchDefaultEffort(twin) &&
      JSON.stringify(resolveModelPricing(id).costs) === JSON.stringify(resolveModelPricing(twin).costs)
    )
  }
  check("what that sentence says is true of every declared mirror: its counterpart's window, effort levels, launch effort and prices", mirrors.length === 3 && mirrors.every(sharesTheFour), mirrors.map(id => `${id} ${sharesTheFour(id)}`).join(' · '))
  check('SESSIONS.md: the saved fable word follows the newest row and a saved full id stays', sessions.includes('`fable` follows the same law: it runs Fable 5.2, and a saved\n`claude-fable-5-1` stays on Fable 5.1.'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} Fable 5.2 row check(s) failed`)
  process.exit(1)
}
console.log(' ALL FABLE 5.2 ROW PROOFS PASS')
