#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const scratch = mkdtempSync(join(tmpdir(), 'family-defaults-'))
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
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_DEFAULT_HAIKU_MODEL',
  'MERCURY_SMALL_FAST_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_PROVIDER_BETAS',
  'NODE_ENV',
]) {
  delete process.env[key]
}
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) {
  process.env[base] = 'http://127.0.0.1:1'
}
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const configs = await import('../../src/utils/model/configs.ts')
const { ALL_MODEL_CONFIGS, familyDefaultsModel, familyHeadOf, parseFirstPartyGeneration } = configs
const model = await import('../../src/utils/model/model.ts')
const caps = await import('../../src/utils/model/capabilities.ts')
const effort = await import('../../src/utils/effort.ts')
const cost = await import('../../src/utils/modelCost.ts')
const { classOfModel } = await import('../../src/utils/router/modelRegistry.ts')
const { focusedOptionSupports1m } = await import('../../src/utils/model/modelOptions.ts')
const { declaredRouteOf } = await import('../../src/services/providers/routeLaw.ts')
const { getGlobalConfig, saveGlobalConfig } = await import('../../src/utils/config.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const show = (v: unknown): string => JSON.stringify(v)

section('§1 the one owner: the family head of an undeclared generation, null for a declared id and an unknown family')
const heads: Array<[string, string, string]> = [
  ['claude-opus-5-7', 'opus', model.getDefaultOpusModel()],
  ['claude-sonnet-5-5', 'sonnet', model.getDefaultSonnetModel()],
  ['claude-fable-5-2', 'fable', model.getDefaultFableModel()],
  ['claude-haiku-5', 'haiku', model.getDefaultHaikuModel()],
  ['claude-opus-6', 'opus', model.getDefaultOpusModel()],
  ['claude-opus-4-9', 'opus', model.getDefaultOpusModel()],
  ['claude-mythos-5-2', 'fable', model.getDefaultFableModel()],
]
for (const [id, family, head] of heads) {
  const key = familyHeadOf(id)
  check(`${id}: the head is the ${family} family's newest row (${head})`, key !== null && ALL_MODEL_CONFIGS[key].firstParty === head && familyDefaultsModel(id) === head && parseFirstPartyGeneration(id)?.family === family, `${String(key)} / ${familyDefaultsModel(id)}`)
  check(`${id}: the rider and the case change nothing`, familyDefaultsModel(`${id.toUpperCase()}[1m]`) === head)
}
for (const config of Object.values(ALL_MODEL_CONFIGS)) {
  check(`${config.firstParty}: a declared id has no head and stands for itself`, familyHeadOf(config.firstParty) === null && familyDefaultsModel(config.firstParty) === config.firstParty)
}
check('a dated snapshot of a declared generation has no head', familyHeadOf('claude-opus-5-20260401') === null && familyHeadOf('claude-opus-4-8-20260101') === null && familyHeadOf('claude-mythos-5-20260401') === null)
check('an unknown family has no head and stands for itself', familyHeadOf('claude-zephyr-1') === null && familyDefaultsModel('claude-zephyr-1') === 'claude-zephyr-1')
check('a carrier-shaped id has no head', familyHeadOf('openrouter/anthropic/claude-opus-5-7') === null && familyHeadOf('anthropic/claude-opus-5-7') === null)

section('§2 every exact-id table answers an undeclared generation as its family head, the cutoff excepted, the name the raw id')
type Reader = [string, (id: string) => unknown]
const readers: Reader[] = [
  ['adaptive thinking', id => caps.modelSupportsAdaptiveThinking(id)],
  ['thinking always on', id => caps.modelThinkingAlwaysOn(id)],
  ['narrates in thinking blocks', id => caps.modelNarratesInThinkingBlocks(id)],
  ['forced tool choice', id => caps.modelSupportsForcedToolChoice(id)],
  ['structured outputs', id => caps.modelSupportsStructuredOutputs(id)],
  ['per-message effort row', id => caps.servesPerMessageEffort(id)],
  ['effort vocabulary', id => caps.effortVocabularyFor(id)],
  ['effort supported / xhigh / max', id => [caps.modelSupportsEffort(id), caps.modelSupportsXHighEffort(id), caps.modelSupportsMaxEffort(id)]],
  ['the deepest effort word', id => caps.getMaxSupportedEffortLevel(id)],
  ['the selectable ladder', id => effort.selectableEffortLevelsForLadder(id)],
  ['1M native', id => caps.modelSupports1M(id)],
  ['the context window and its source', id => [caps.resolveContextWindow(id).effectiveWindow, caps.resolveContextWindow(id).source]],
  ['the output token pair', id => caps.getModelMaxOutputTokens(id)],
  ['the launch pin and its default', id => [effort.isLaunchEffortPinned(id), effort.getLaunchDefaultEffort(id)]],
  ['the default effort', id => effort.getDefaultEffortForModel(id)],
  ['the router class', id => classOfModel(id)],
  ['the picker 1M toggle', id => focusedOptionSupports1m(id)],
  ['the route', id => declaredRouteOf(id)],
]
for (const [id, , head] of heads) {
  for (const [name, read] of readers) {
    check(`${id}: ${name} answers as ${head}`, show(read(id)) === show(read(head)), `${show(read(id))} vs ${show(read(head))}`)
  }
  const pricing = cost.resolveModelPricing(id)
  const headPricing = cost.resolveModelPricing(head)
  check(`${id}: the cost tier is the head's, flagged as a family estimate`, pricing.basis === 'family-estimate' && headPricing.basis === 'recorded' && show(pricing.costs) === show(headPricing.costs), show(pricing))
  check(`${id}: the knowledge cutoff is null (a date is a fact about a model, never a default)`, caps.getModelKnowledgeCutoff(id) === null, String(caps.getModelKnowledgeCutoff(id)))
  check(`${id}: the display name is the raw id`, model.renderModelName(id) === id && model.getPublicModelDisplayName(id) === null && model.renderModelChip(id) === id)
  check(`${id}: the canonical is its own stem, never the head's`, model.getCanonicalName(id) !== model.getCanonicalName(head) && model.getCanonicalName(id) === (parseFirstPartyGeneration(id)?.stem ?? ''), model.getCanonicalName(id))
}

section('§3 the launch flag is the head\'s: unpinning the head\'s family unpins the undeclared generation with it')
{
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: { opus55: true } }))
  check("with the opus55 flag set, claude-opus-5-7 reads unpinned like its head, and Opus 5 keeps its own pin", !effort.isLaunchEffortPinned('claude-opus-5-7') && !effort.isLaunchEffortPinned(model.getDefaultOpusModel()) && effort.isLaunchEffortPinned('claude-opus-5'))
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: { opus5: true } }))
  check("with only the opus5 flag set, claude-opus-5-7 stays pinned (its head's flag is opus55)", effort.isLaunchEffortPinned('claude-opus-5-7') && !effort.isLaunchEffortPinned('claude-opus-5'))
  saveGlobalConfig(current => ({ ...current, launchEffortUnpins: {} }))
  check('the flags are cleared again', show((getGlobalConfig() as { launchEffortUnpins?: unknown }).launchEffortUnpins) === '{}')
}

section('§4 the refused-latch still comes first for the per-message effort row')
{
  caps.resetPerMessageEffortRefusals()
  check('claude-fable-5-2 serves the row as its head does', caps.servesPerMessageEffort('claude-fable-5-2') === caps.servesPerMessageEffort(model.getDefaultFableModel()) && caps.servesPerMessageEffort('claude-fable-5-2'))
  caps.notePerMessageEffortRefused('claude-fable-5-2')
  check('a refusal noted on the raw id switches the row off for it alone', !caps.servesPerMessageEffort('claude-fable-5-2') && caps.servesPerMessageEffort(model.getDefaultFableModel()))
  caps.resetPerMessageEffortRefusals()
}

section('§5 an id of a family the table does not declare takes the generic first-party road, recorded here')
{
  const id = 'claude-zephyr-1'
  check('the route is anthropic by the claude- mark', declaredRouteOf(id) === 'anthropic')
  check('the canonical is the generic id itself', model.getCanonicalName(id) === id)
  check('no router class', classOfModel(id) === undefined)
  const pricing = cost.resolveModelPricing(id)
  const otherUnknown = cost.resolveModelPricing('claude-nobody-9')
  check('the cost is the generic first-party estimate every unknown family shares, flagged as one (no invented tier)', pricing.basis === 'family-estimate' && otherUnknown.basis === 'family-estimate' && show(pricing.costs) === show(otherUnknown.costs), show(pricing))
  const vocabulary = caps.effortVocabularyFor(id)
  check('effort on with the unknown-id ladder', vocabulary.kind === 'ladder' && vocabulary.source === 'unknown-id' && caps.modelSupportsEffort(id), show(vocabulary))
  check('unpinned launch effort at high', !effort.isLaunchEffortPinned(id) && effort.getLaunchDefaultEffort(id) === 'high')
  check('adaptive thinking on (the unknown default), thinking not always on, forced tool choice kept, structured outputs off, no per-message effort row', caps.modelSupportsAdaptiveThinking(id) && !caps.modelThinkingAlwaysOn(id) && caps.modelSupportsForcedToolChoice(id) && !caps.modelSupportsStructuredOutputs(id) && !caps.servesPerMessageEffort(id))
  check('not natively 1M; the conservative window; the default output pair', !caps.modelSupports1M(id) && caps.resolveContextWindow(id).effectiveWindow === 200_000 && caps.resolveContextWindow(id).source === 'fallback' && caps.getModelMaxOutputTokens(id).default === 32_000 && caps.getModelMaxOutputTokens(id).upperLimit === 64_000, show(caps.resolveContextWindow(id)))
  check('no cutoff, the raw id as its name, no 1M toggle', caps.getModelKnowledgeCutoff(id) === null && model.renderModelName(id) === id && !focusedOptionSupports1m(id))
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\nprove-family-defaults: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
