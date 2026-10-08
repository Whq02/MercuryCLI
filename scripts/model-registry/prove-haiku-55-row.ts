import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'haiku-55-row-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
for (const key of ['MERCURY_MODEL', 'MERCURY_DEFAULT_HAIKU_MODEL', 'MERCURY_SMALL_FAST_MODEL', 'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_PROVIDER_BETAS', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

const ID = 'claude-haiku-5-5'
const OLD = 'claude-haiku-4-5-20251001'
let failures = 0
function check(label: string, condition: boolean, detail?: unknown): void {
  if (!condition) failures++
  console.log(`[${condition ? 'PASS' : 'FAIL'}] ${label}${!condition && detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const close = (actual: number, expected: number): boolean => Math.abs(actual - expected) < 1e-10

try {
  const model = await import('../../src/utils/model/model.ts')
  const configs = await import('../../src/utils/model/configs.ts')
  const caps = await import('../../src/utils/model/capabilities.ts')
  const effort = await import('../../src/utils/effort.ts')
  const cost = await import('../../src/utils/modelCost.ts')
  const { recognizeModelId } = await import('../../src/services/providers/idSpaces.ts')
  const { getModelOptions, focusedOptionSupports1m } = await import('../../src/utils/model/modelOptions.ts')
  const { classOfModel } = await import('../../src/utils/router/modelRegistry.ts')
  const { routeEffortsFor } = await import('../../src/utils/router/providers/anthropic.ts')
  const { sideQueryThinkingParam } = await import('../../src/utils/sideQuery.ts')
  const { getAgentModel } = await import('../../src/utils/model/agent.ts')

  check('Haiku 5.5 has its own canonical and declared row', model.getCanonicalName(ID) === ID && configs.familyHeadOf(ID) === null)
  check('case and context annotation retain the canonical', model.getCanonicalName('Claude-Haiku-5-5[1m]') === ID)
  check('the display owner names Haiku 5.5', model.renderModelName(ID) === 'Haiku 5.5' && model.getMarketingNameForModel(ID) === 'Haiku 5.5', model.renderModelName(ID))
  check('display annotation, chip and public name derive from the row', model.renderModelName(`${ID}[1m]`) === 'Haiku 5.5 (1M context)' && model.renderModelChip(ID) === 'Haiku 5.5' && model.getPublicModelName(ID) === 'Claude Haiku 5.5')
  check('haiku55 is an exact-generation alias', model.parseUserSpecifiedModel('haiku55') === ID && model.parseUserSpecifiedModel('haiku55[1m]') === `${ID}[1m]`)
  const recognition = recognizeModelId('haiku55')
  check('id-space recognition agrees with the alias', recognition.kind === 'first-party' && recognition.why === 'alias')
  check('Haiku family order is newest first and preserves 4.5', configs.FAMILY_GENERATIONS.haiku.join(',') === 'haiku55,haiku45', configs.FAMILY_GENERATIONS.haiku)
  check('family default, small-fast helper and crew family word use the new head', model.getDefaultHaikuModel() === ID && model.getSmallFastModel() === ID && model.parseUserSpecifiedModel('haiku') === ID && getAgentModel('haiku', 'claude-sonnet-5-5') === ID)
  check('a saved full 4.5 ID stays on 4.5', model.parseUserSpecifiedModel(OLD) === OLD && model.renderModelName(OLD) === 'Haiku 4.5')
  check('the spoken display name resolves to the new row', model.parseUserSpecifiedModel('Haiku 5.5') === ID)
  const rows = getModelOptions({ anthropicCredentialed: () => true }).filter(row => row.group === undefined)
  const values = rows.map(row => row.value)
  check('the picker offers one named selectable 5.5 row', rows.filter(row => row.value === ID).length === 1 && rows.find(row => row.value === ID)?.label === 'Haiku 5.5' && rows.find(row => row.value === ID)?.unavailable === undefined, values)
  check('the 4.5 row follows the new family head immediately', values.indexOf(ID) >= 0 && values.indexOf(OLD) === values.indexOf(ID) + 1, values)
  check('native 1M has no duplicate picker row or toggle', !values.includes(`${ID}[1m]`) && !focusedOptionSupports1m(ID))
  check('the house router keeps Haiku outside its seat classes', classOfModel(ID) === undefined && classOfModel(OLD) === undefined)
  const React = (await import('react')).default
  const { renderToString } = await import('../../src/utils/staticRender.tsx')
  const { MercuryModelPicker, fmtCtx } = await import('../../src/components/MercuryModelPicker.tsx')
  const choices = rows.map(row => ({ id: row.value, name: row.label, tag: row.description, ctx: fmtCtx(caps.getContextWindowForModel(row.value)), group: 'Anthropic' }))
  for (const columns of [120, 178]) {
    const frame = await renderToString(React.createElement(MercuryModelPicker, { models: choices, current: ID, ctxPct: null }), columns)
    const line = frame.split('\n').find(line => line.includes(ID) && line.includes('Haiku 5.5')) ?? ''
    check(`[${columns}] the rendered current row has its name, 1M context and no unknown-row label`, line.includes('current') && line.includes('1M') && !line.includes('no alias') && !line.includes('new'), line)
    console.log(`FRAME ${columns}: ${line}`)
  }

  check('native context is 1M from the explicit pin', caps.getContextWindowForModel(ID) === 1_000_000 && caps.resolveContextWindow(ID).source === 'static-pin' && caps.modelSupports1M(ID), caps.resolveContextWindow(ID))
  check('both requested output and ceiling are the documented synchronous 128K', caps.getModelMaxOutputTokens(ID).default === 128_000 && caps.getModelMaxOutputTokens(ID).upperLimit === 128_000, caps.getModelMaxOutputTokens(ID))
  check('adaptive thinking, interleaving and no temperature', caps.modelSupportsThinking(ID) && caps.modelSupportsAdaptiveThinking(ID) && caps.modelSupportsISP(ID) && !caps.modelSupportsTemperature(ID))
  check('thinking can be switched off and forced tool choice remains supported', !caps.modelThinkingAlwaysOn(ID) && caps.modelSupportsForcedToolChoice(ID))
  check('side queries use adaptive without a manual budget, or documented disabled', JSON.stringify(sideQueryThinkingParam(ID, 2048, 4096)) === '{"type":"adaptive"}' && JSON.stringify(sideQueryThinkingParam(ID, false, 4096)) === '{"type":"disabled"}')
  const forced = { type: 'tool', name: 'result' }
  check('forced tool choice is not rewritten to auto', caps.foldToolChoiceForModel(ID, forced) === forced)
  check('the documented effort ladder includes xhigh and max without remapping', effort.selectableEffortLevelsForLadder(ID).join(',') === 'low,medium,high,xhigh,max' && caps.getMaxSupportedEffortLevel(ID) === 'max' && routeEffortsFor(ID).join(',') === 'high,xhigh,max')
  check('the unpinned default is medium and a requested max stays max on the wire', !effort.isLaunchEffortPinned(ID) && effort.getDefaultEffortForModel(ID) === 'medium' && effort.resolveEffortTruth(ID, 'max').wire === 'max' && effort.resolveEffortTruth(ID, undefined).wire === 'medium')
  check('PDF, images and structured output reach the home route', caps.modelSupportsPDF(ID) && caps.modelReceivesImageBlocks(ID) && caps.modelSupportsStructuredOutputs(ID))
  check('the June 2026 cutoff is a recorded fact', caps.getModelKnowledgeCutoff(ID) === 'June 2026')
  check('no native-context beta or unmeasured per-message-effort beta is added', !caps.getAllModelBetas(ID).some(beta => beta.startsWith('context-1m')) && !caps.servesPerMessageEffort(ID))
  check('4.5 capability truth remains unchanged', !caps.modelSupportsAdaptiveThinking(OLD) && !caps.modelSupportsEffort(OLD) && caps.getContextWindowForModel(OLD) === 200_000 && caps.getModelMaxOutputTokens(OLD).upperLimit === 64_000)
  const carrier = `openrouter/anthropic/${ID}`
  check('a carrier ID never takes first-party facts', model.getCanonicalName(carrier) === carrier && !caps.modelSupports1M(carrier) && !caps.modelSupportsStructuredOutputs(carrier) && caps.getModelKnowledgeCutoff(carrier) === null)
  const truth = caps.resolveModelCapabilities(ID)
  check('the combined capability record agrees', truth.identity.isHaiku && truth.thinking.adaptive && truth.effort.ceiling === 'max' && truth.context.window === 1_000_000 && truth.context.outputDefault === 128_000, truth)

  const low = cost.resolveModelPricing(ID, { promptTokens: 100_000 })
  const high = cost.resolveModelPricing(ID, { promptTokens: 100_001 })
  check('at 100K the recorded prices are $0.10/$0.50 with $0.125 write and $0.01 read', low.basis === 'recorded' && low.costs.inputTokens === 0.1 && low.costs.outputTokens === 0.5 && low.costs.promptCacheWriteTokens === 0.125 && close(low.costs.promptCacheReadTokens, 0.01), low)
  check('above 100K all prices move to the recorded higher tier', high.basis === 'recorded' && high.costs.inputTokens === 0.5 && high.costs.outputTokens === 2.5 && high.costs.promptCacheWriteTokens === 0.625 && high.costs.promptCacheReadTokens === 0.05, high)
  check('price display records the entry tier', cost.getModelPricingString(ID) === '$0.10/$0.50 per Mtok', cost.getModelPricingString(ID))
  check('case and annotation keep recorded pricing', cost.resolveModelPricing('Claude-Haiku-5-5[1m]', { promptTokens: 100_001 }).costs.outputTokens === 2.5)
  check('output tokens do not trigger the longer-prompt tier', close(cost.calculateUSDCost(ID, { input_tokens: 100_000, output_tokens: 128_000 }), 0.074))
  check('cache reads and writes both count toward the 100K threshold', close(cost.calculateUSDCost(ID, { input_tokens: 1, output_tokens: 100, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 50_000 }), 0.0340005))
  check('one-hour writes cost $0.20 below and $1 above the threshold', close(cost.calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_000, cache_creation: { ephemeral_1h_input_tokens: 100_000 } }), 0.02) && close(cost.calculateUSDCost(ID, { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100_001, cache_creation: { ephemeral_1h_input_tokens: 100_001 } }), 0.100001))
  check('4.5 keeps its own recorded $1/$5 prices', cost.getModelPricingString(OLD) === '$1/$5 per Mtok')
  const engines = readFileSync(join(import.meta.dir, '../../docs/ENGINES.md'), 'utf8')
  check('ENGINES records the row, family word and context', engines.includes('`haiku` means Haiku 5.5') && engines.includes('`claude-haiku-5-5`') && engines.includes('128K output'))
} finally {
  rmSync(home, { recursive: true, force: true })
}
console.log(`\nprove-haiku-55-row: ${failures === 0 ? 'PASS' : `FAIL — ${failures} checks`}`)
process.exit(failures === 0 ? 0 : 1)
