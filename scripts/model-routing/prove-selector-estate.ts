#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const savedEnv: Record<string, string | undefined> = {}
for (const key of ['MERCURY_CONFIG_DIR', 'MERCURY_DISABLE_1M_CONTEXT']) {
  savedEnv[key] = process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-apex-selectors-'))
delete process.env.MERCURY_DISABLE_1M_CONTEXT

const {
  parseGptModelId,
  gptDisplayName,
  gptDisplayPin,
} = await import('../../src/services/providers/openai/gptPins.js')
const { getPublicModelDisplayName, getMarketingNameForModel, renderModelChip } = await import(
  '../../src/utils/model/model.js'
)
const { getContextWindowForModel } = await import('../../src/utils/context.js')
const { getModelPricingString, calculateCostFromTokens } = await import('../../src/utils/modelCost.js')
const { decideModelTransition, providerFamilyOfSetting, crossProviderNote } = await import(
  '../../src/utils/model/modelTransition.js'
)

console.log('============================================================')
console.log(' selector estate + ModelTransition proof')
console.log('============================================================')

section('1 · the PURE grammar — numeric parse (the semantic foundation)')
{
  const sol = parseGptModelId('GPT-5.6-Sol')
  check('parses + canonicalizes (case-folded)', sol?.major === 5 && sol.minor === 6 && sol.variant === 'sol' && sol.canonicalId === 'gpt-5.6-sol')
  check('the class alias never parses', parseGptModelId('gpt') === undefined)
  check('non-gpt ids never parse', parseGptModelId('claude-opus-4-8') === undefined && parseGptModelId('glm-5.2') === undefined)
  const nova = parseGptModelId('gpt-5.10-nova')
  check('5.10 parses minor = ten (numeric, not lexicographic)', nova?.major === 5 && nova.minor === 10)
  const six = parseGptModelId('gpt-6')
  check('bare major parses (6 → minor 0)', six?.major === 6 && six.minor === 0)
}

section('2 · display — the official names, everywhere the estate renders')
{
  check("getPublicModelDisplayName('gpt-5.6-sol') = 'GPT-5.6 Sol'", getPublicModelDisplayName('gpt-5.6-sol') === 'GPT-5.6 Sol')
  check("marketing name matches", getMarketingNameForModel('gpt-5.6-sol') === 'GPT-5.6 Sol')
  check("chip renders the friendly name", renderModelChip('gpt-5.6-terra') === 'GPT-5.6 Terra')
  check("unpinned parseable id gets the mechanical title", gptDisplayName('gpt-5.7-nova') === 'GPT-5.7 Nova')
  check('non-gpt ids stay untouched (null display)', gptDisplayName('claude-opus-4-8') === undefined)
}

section('3 · context — the pin drives the uncredentialed budget; kill-switch capped')
{
  const solPin = gptDisplayPin('gpt-5.6-sol')
  check(
    'Sol budget derives from the recorded pin window (dated observation)',
    solPin?.contextWindow !== undefined &&
      typeof solPin.observedAt === 'string' &&
      getContextWindowForModel('gpt-5.6-sol') === solPin.contextWindow,
  )
  check('unpinned gpt id keeps the conservative default (200K — compact early)', getContextWindowForModel('gpt-5.7-nova') === 200_000)
  process.env.MERCURY_DISABLE_1M_CONTEXT = '1'
  check('the 1M kill-switch caps the pinned window', getContextWindowForModel('gpt-5.6-sol') === 200_000)
  delete process.env.MERCURY_DISABLE_1M_CONTEXT
}

section('4 · cost — prices DERIVE from the pin, incl. the recorded cached rate')
{
  const solPin = gptDisplayPin('gpt-5.6-sol')!
  const lunaPin = gptDisplayPin('gpt-5.6-luna')!
  check(
    "Sol pricing string derives from the pin's recorded rates",
    getModelPricingString('gpt-5.6-sol') === `$${solPin.costInPerMtok}/$${solPin.costOutPerMtok} per Mtok`,
  )
  check(
    "Luna pricing string derives from the pin's recorded rates",
    getModelPricingString('gpt-5.6-luna') === `$${lunaPin.costInPerMtok}/$${lunaPin.costOutPerMtok} per Mtok`,
  )
  const cachedOnly = calculateCostFromTokens('gpt-5.6-sol', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
  })
  check(
    "Sol cached-input rate is the pin's RECORDED rate",
    solPin.cachedInPerMtok !== undefined && Math.abs(cachedOnly - solPin.cachedInPerMtok) < 1e-9,
    String(cachedOnly),
  )
  const terraPin = gptDisplayPin('gpt-5.6-terra')!
  const terraCached = calculateCostFromTokens('gpt-5.6-terra', {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 1_000_000,
    cacheCreationInputTokens: 0,
  })
  check(
    'Terra (no recorded cached rate) falls to the 0.1× convention off its input rate',
    terraPin.cachedInPerMtok === undefined &&
      terraPin.costInPerMtok !== undefined &&
      Math.abs(terraCached - terraPin.costInPerMtok * 0.1) < 1e-9,
    String(terraCached),
  )
  check('Sol pin records an output ceiling (the runtime reads it, never invents one)', solPin.outputMax !== undefined)
}

section('4b · the FULL lineup sweeps the same consumers (provider parity)')
{
  const { GPT_DISPLAY_PINS } = await import('../../src/services/providers/openai/gptPins.js')
  const { getModelMaxOutputTokens } = await import('../../src/utils/model/capabilities.js')
  check('the lineup is the full current models page (8 pins)', GPT_DISPLAY_PINS.length === 8)
  for (const pin of GPT_DISPLAY_PINS) {
    const identity = parseGptModelId(pin.id)
    check(`${pin.id}: identity parses (canonical = the pin id)`, identity?.canonicalId === pin.id)
    check(
      `${pin.id}: display resolves the pin name through the estate`,
      getPublicModelDisplayName(pin.id) === pin.displayName,
      `got ${getPublicModelDisplayName(pin.id)}`,
    )
    const window = getContextWindowForModel(pin.id)
    check(
      `${pin.id}: window = ${pin.contextWindow !== undefined ? 'the recorded pin fact' : 'the honest conservative default'} (uncredentialed here)`,
      pin.contextWindow !== undefined ? window === pin.contextWindow : window === 200_000,
      `got ${window}`,
    )
    const out = getModelMaxOutputTokens(pin.id)
    check(
      `${pin.id}: output cap = ${pin.outputMax !== undefined ? 'the recorded pin fact' : 'the conservative default'}`,
      pin.outputMax !== undefined
        ? out.upperLimit === pin.outputMax && out.default === Math.min(64_000, pin.outputMax)
        : out.upperLimit === 64_000 && out.default === 32_000,
      `got ${JSON.stringify(out)}`,
    )
    const pricing = getModelPricingString(pin.id)
    check(
      `${pin.id}: pricing = ${pin.costInPerMtok !== undefined ? 'the recorded rate' : 'undefined (never invented)'}`,
      pin.costInPerMtok !== undefined ? pricing !== undefined : pricing === undefined,
      `got ${pricing}`,
    )
  }
}

section('5 · the ModelTransition decision matrix (decision #7)')
{
  const samePick = decideModelTransition({ currentSetting: 'gpt-5.6-sol', nextSetting: 'gpt-5.6-sol', turnActive: true })
  check('same-model ⇒ no-op even mid-turn', samePick.kind === 'no-op-same')
  const idle = decideModelTransition({ currentSetting: 'opus[1m]', nextSetting: 'gpt-5.6-sol', turnActive: false })
  check('idle ⇒ apply-now, cross-provider flagged', idle.kind === 'apply-now' && idle.crossProvider === true)
  const midTurn = decideModelTransition({ currentSetting: 'opus[1m]', nextSetting: 'gpt-5.6-sol', turnActive: true })
  check('active turn ⇒ defer-pending, cross-provider flagged', midTurn.kind === 'defer-pending' && midTurn.crossProvider === true)
  const sameFamily = decideModelTransition({ currentSetting: 'opus', nextSetting: 'claude-sonnet-5', turnActive: true })
  check('anthropic → anthropic mid-turn ⇒ defer, NOT cross-provider', sameFamily.kind === 'defer-pending' && sameFamily.crossProvider === false)
  const back = decideModelTransition({ currentSetting: 'gpt-5.6-sol', nextSetting: null, turnActive: false })
  check('gpt → Default ⇒ apply-now cross-provider (back to Anthropic)', back.kind === 'apply-now' && back.crossProvider === true)
  check("families: gpt ⇒ 'openai' · glm ⇒ 'zai' · opus ⇒ 'anthropic'", providerFamilyOfSetting('gpt-5.6-sol') === 'openai' && providerFamilyOfSetting('glm-5.2') === 'zai' && providerFamilyOfSetting('opus') === 'anthropic')
  check('the cross-provider note names the transport change', crossProviderNote('gpt-5.6-sol').includes('Responses'))
  check('the return sentence is reserved for the Anthropic destination', crossProviderNote(null).includes('return to the Anthropic transport') && crossProviderNote('opus').includes('return to the Anthropic transport'))
  check('a gemini destination is NAMED, never claimed as an Anthropic return', crossProviderNote('gemini-3-pro').includes('the Gemini transport') && !crossProviderNote('gemini-3-pro').includes('return to the Anthropic'))
  check('a deepseek destination the same', crossProviderNote('deepseek-v4').includes('the DeepSeek transport') && !crossProviderNote('deepseek-v4').includes('return to the Anthropic'))
  check('an unrecognised setting claims only the change', crossProviderNote('some-vendor-model').includes('the transport changes with it') && !crossProviderNote('some-vendor-model').includes('return to the Anthropic'))
}

section('6 · retention + wiring (structural — the module graph is not bun-loadable)')
{
  const restore = readFileSync(join(ROOT, 'src', 'utils', 'sessionRestore.ts'), 'utf8')
  const retained = readFileSync(join(ROOT, 'src', 'utils', 'model', 'retainedModel.ts'), 'utf8')
  check(
    '§8 retention is family-blind (no id-spelling gate; the synthetic sentinel is the one exclusion)',
    !restore.includes(".startsWith('claude-')") &&
      !restore.includes('(gpt|glm)-') &&
      !retained.includes(".startsWith('claude-')") &&
      !retained.includes('(gpt|glm)-') &&
      retained.includes('model !== SYNTHETIC_MODEL') &&
      restore.includes("from './model/retainedModel.js'"),
  )
  const prompt = readFileSync(join(ROOT, 'src', 'components', 'PromptInput', 'PromptInput.tsx'), 'utf8')
  check(
    'the picker consumes the settlement owner (settleModelSelection wraps decideModelTransition)',
    prompt.includes('settleModelSelection(') && !prompt.includes('decideModelTransition({'),
  )
  check(
    'a deferred pick parks in pendingModelSwitch (last-chosen wins, via the owner patch)',
    /pendingModelSwitch: \{ setting: next \}/.test(
      readFileSync(join(ROOT, 'src', 'utils', 'model', 'modelTransition.ts'), 'utf8'),
    ),
  )
  const repl = readFileSync(join(ROOT, 'src', 'screens', 'REPL.tsx'), 'utf8')
  check(
    'the REPL boundary effect applies the parked switch exactly-once',
    repl.includes('pendingModelSwitch === null) return') &&
      repl.includes('settlePendingAtBoundary(') &&
      repl.includes('lastModelTransition: settled.receipt'),
  )
  const picker = readFileSync(join(ROOT, 'src', 'utils', 'model', 'modelOptions.ts'), 'utf8')
  check(
    "/model gains the qualified-GPT group behind the engines+account+catalogue gate",
    picker.includes('getQualifiedGptOptions') && picker.includes('qualifiedGptCandidates'),
  )
}

for (const [key, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('ALL SELECTOR-ESTATE PROOFS PASS')
else console.log(`${failures} SELECTOR-ESTATE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
