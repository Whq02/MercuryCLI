#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of ['OPENAI_API_KEY', 'ZAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_API_BASE']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-effort-vocab-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

let failures = 0
const EFFORT_VOCAB_FIX_HINT_BY_SECTION: Record<string, string> = {
  '1': 'change resolveEffortTruth in src/models/effort/effort.ts, KIMI_EFFORTS in src/models/facts/pins/kimiPins.ts, or buildMoonshotExtras in src/models/roads/openaicompat/compatWire.ts so truth and wire agree',
  '2': 'change resolveEffortTruth in src/models/effort/effort.ts, DEEPSEEK_EFFORTS in src/models/facts/pins/deepseekPins.ts, or buildDeepseekExtras in src/models/roads/openaicompat/compatWire.ts so truth and wire agree',
  '3': 'change resolveEffortTruth in src/models/effort/effort.ts or glmEffortsFor and glmAcceptsEffort in src/models/facts/pins/glmPins.ts',
  '4': 'change getDisplayedEffortLevel, resolveAppliedEffort, selectableEffortLevels or resolveWireRequestedEffort in src/models/effort/effort.ts so they read resolveEffortTruth',
}
let effortVocabFixHint = ''
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${detail ? `${detail} — ` : ''}${effortVocabFixHint}` : ''}`)
}
function section(t: string): void {
  effortVocabFixHint = EFFORT_VOCAB_FIX_HINT_BY_SECTION[t.charAt(1)] ?? ''
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const effort = await import('../../src/models/effort/effort.ts')
const wire = await import('../../src/models/roads/openaicompat/compatWire.ts')
const { glmEffortsFor, glmAcceptsEffort } = await import('../../src/models/facts/pins/glmPins.ts')
const { nearestSupportedWireEffort } = await import('../../src/models/facts/pins/gptPins.ts')
const { KIMI_EFFORTS } = await import('../../src/models/facts/pins/kimiPins.ts')
const { DEEPSEEK_EFFORTS } = await import('../../src/models/facts/pins/deepseekPins.ts')

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
const PROVIDER_DEFAULT_LABEL = 'default'

const moonshotWire = (request: string | undefined): string | undefined =>
  (wire.buildMoonshotExtras({ wireModel: 'kimi-k3', effortValue: request, thinkingEnabled: true, maxOutputTokensOverride: undefined }) as { reasoning_effort?: string }).reasoning_effort
const deepseekWire = (request: string | undefined): string | undefined =>
  (wire.buildDeepseekExtras({ wireModel: 'deepseek-flash', effortValue: request, thinkingEnabled: true, maxOutputTokensOverride: undefined }) as { reasoning_effort?: string }).reasoning_effort
const glmWire = (model: string, request: string | undefined): string | undefined => {
  const vocabulary = glmEffortsFor(model)
  return request && vocabulary ? (glmAcceptsEffort(model, request) ? request : nearestSupportedWireEffort(request, [...vocabulary])) : undefined
}

console.log('the effort truth names the tier the wire carries — documented-vocabulary lanes')

section('§1 Kimi K3: the truth steps through the wire\'s vocabulary (low | high | max)')
{
  const medium = effort.resolveEffortTruth('kimi-k3', 'medium')
  check("MEDIUM DISPATCHES HIGH, AND THE TRUTH SAYS SO (the base displayed 'medium'; kimi.com/code/docs/en/kimi-code/models.html, 2026-10-28, maps medium to high)", medium.wire === 'high' && medium.label === 'high' && medium.applied === 'high', JSON.stringify(medium))
  check('…with adjustedFrom naming the request', medium.adjustedFrom === 'medium')
  check('…and the wire builder agrees byte for byte', moonshotWire('medium') === medium.wire, `wire builder: ${String(moonshotWire('medium'))}`)
  for (const level of LEVELS) {
    const truth = effort.resolveEffortTruth('kimi-k3', level)
    check(`${level}: truth.wire ≡ the builder's reasoning_effort`, truth.wire === moonshotWire(level), `${String(truth.wire)} vs ${String(moonshotWire(level))}`)
    check(`${level}: the label IS the wire tier`, truth.label === truth.wire)
    check(`${level}: adjustedFrom exactly when the tier moved`, (truth.adjustedFrom !== undefined) === (truth.wire !== level))
  }
  const none = effort.resolveEffortTruth('kimi-k3', undefined)
  check('no request ⇒ no key on the wire and the provider-default label (the base labelled it medium)', none.wire === undefined && none.label === PROVIDER_DEFAULT_LABEL && moonshotWire(undefined) === undefined, JSON.stringify(none))
  check('the selectable stops are the vocabulary (no medium stop to pick)', JSON.stringify(none.selectable) === JSON.stringify(['low', 'high', 'max']), JSON.stringify(none.selectable))
  check('the provider vocabulary rides the record', JSON.stringify(none.providerVocabulary) === JSON.stringify([...KIMI_EFFORTS]))
  check("the catalogue is 'documented-vocabulary'", none.catalogue === 'documented-vocabulary')
  const undocumented = effort.resolveEffortTruth('kimi-k2.7-code', 'high')
  check('a Kimi id without a documented vocabulary has no dial (no key, the one absence word)', undocumented.supportsEffort === false && undocumented.wire === undefined && undocumented.label === effort.NO_EFFORT_CONTROL_LABEL, JSON.stringify(undocumented))
}

section('§2 DeepSeek: the same law on the second lane')
{
  for (const level of LEVELS) {
    const truth = effort.resolveEffortTruth('deepseek-flash', level)
    check(`${level}: truth.wire ≡ the builder's top-level reasoning_effort`, truth.wire === deepseekWire(level), `${String(truth.wire)} vs ${String(deepseekWire(level))}`)
    check(`${level}: the label IS the wire tier`, truth.label === truth.wire)
  }
  const medium = effort.resolveEffortTruth('deepseek-v4-pro', 'medium')
  check("medium on DeepSeek Pro ⇒ low, adjusted from medium (the base said 'medium')", medium.wire === 'low' && medium.adjustedFrom === 'medium' && medium.label === 'low')
  check('the selectable stops are low | high | max', JSON.stringify(medium.selectable) === JSON.stringify([...DEEPSEEK_EFFORTS].filter(l => LEVELS.includes(l as Level))))
  const numeric = effort.resolveEffortTruth('deepseek-flash', 50)
  check('a numeric request is not a documented word: no key, provider default', numeric.wire === undefined && numeric.label === PROVIDER_DEFAULT_LABEL)
}

section('§3 GLM per model: glm-5.3 steps, glm-5.2 keeps its set, an undocumented id has no dial')
{
  const xhigh = effort.resolveEffortTruth('glm-5.3', 'xhigh')
  check("XHIGH ON GLM-5.3 DISPATCHES HIGH, AND THE TRUTH SAYS SO (the base displayed 'xhigh' from the union)", xhigh.wire === 'high' && xhigh.label === 'high' && xhigh.adjustedFrom === 'xhigh', JSON.stringify(xhigh))
  const medium = effort.resolveEffortTruth('glm-5.3', 'medium')
  check('medium on glm-5.3 ⇒ low, adjusted from medium', medium.wire === 'low' && medium.label === 'low' && medium.adjustedFrom === 'medium')
  for (const model of ['glm-5.3', 'glm-5.2']) {
    for (const level of LEVELS) {
      const truth = effort.resolveEffortTruth(model, level)
      check(`${model} ${level}: truth.wire ≡ the zai wire's expression`, truth.wire === glmWire(model, level), `${String(truth.wire)} vs ${String(glmWire(model, level))}`)
    }
  }
  const full = effort.resolveEffortTruth('glm-5.2', 'xhigh')
  check('glm-5.2 keeps xhigh (its own set has it — never the narrowest model\'s)', full.wire === 'xhigh' && full.adjustedFrom === undefined)
  check('glm-5.3 offers low | high | max only', JSON.stringify(effort.resolveEffortTruth('glm-5.3', undefined).selectable) === JSON.stringify(['low', 'high', 'max']))
  check('glm-5.2 offers its five ladder words', JSON.stringify(effort.resolveEffortTruth('glm-5.2', undefined).selectable) === JSON.stringify(LEVELS))
  check('the provider vocabulary is the MODEL\'s, not the union', JSON.stringify(effort.resolveEffortTruth('glm-5.3', undefined).providerVocabulary) === JSON.stringify([...glmEffortsFor('glm-5.3')!]))
  const undocumented = effort.resolveEffortTruth('glm-4.9', 'high')
  check('an undocumented glm id has no dial', undocumented.supportsEffort === false && undocumented.wire === undefined)
}

section('§4 the projections every surface reads agree with the truth')
{
  check("the chip's word for medium on kimi-k3 is high (the step Kimi documents)", effort.getDisplayedEffortLevel('kimi-k3', 'medium') === 'high')
  check("the chip's word for xhigh on glm-5.3 is high", effort.getDisplayedEffortLevel('glm-5.3', 'xhigh') === 'high')
  check('the applied value follows the wire', effort.resolveAppliedEffort('deepseek-flash', 'medium') === 'low')
  check('the selectable stops on kimi-k3 carry no medium', !effort.selectableEffortLevels('kimi-k3').includes('medium'))
  check("the wire's requested string stays the REQUEST (the builders step it themselves — one table, two readers)", effort.resolveWireRequestedEffort('kimi-k3', 'medium') === 'medium')
  const sonnet = effort.resolveEffortTruth('claude-sonnet-5', 'medium')
  check('a first-party id still rides the ladder (medium stays medium)', sonnet.catalogue === 'static-tables' && sonnet.wire === 'medium', JSON.stringify(sonnet))
}


console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-effort-vocabulary-truth${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
