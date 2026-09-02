#!/usr/bin/env bun
// ============================================================================
//  scripts/model-routing/prove-effort-vocabulary-truth.ts — the effort truth
//  on the documented-vocabulary lanes names the tier the wire carries
//  (FN-018 ranks 6 + 7).
//
//  The wire builders resolve a request against each lane's DOCUMENTED
//  vocabulary, nearest-below: Kimi K3 and DeepSeek speak low|high|max
//  (compatWire's buildMoonshotExtras / buildDeepseekExtras), glm-5.3 speaks
//  low|high|max while glm-5.2 has the seven-level set (zaiCallModel over
//  glmEffortsFor). The display truth did not:
//   · rank 6 — Kimi and DeepSeek rode the ladder branch, which treats
//     low/medium/high as universal and steps only max/xhigh, so 'medium'
//     (the lane default under deep reasoning, a common pick) displayed
//     medium on the chip, the slider, the /effort confirmation and the
//     byline while the wire sent low — one full tier below every readout;
//   · rank 7 — the GLM branch tested the UNION vocabulary, so glm-5.3
//     offered and displayed xhigh and medium while the wire served high
//     and low, and adjustedFrom stayed absent because the union check
//     passed.
//  One owner (documentedEffortVocabulary) now feeds the truth, and the
//  truth steps through the SAME table the wire steps through.
//
//   §1 Kimi K3: the resolution table against the wire builder
//   §2 DeepSeek: the same law on the second lane
//   §3 GLM per model: glm-5.3 steps, glm-5.2 keeps its seven levels, an
//      undocumented glm id has no dial
//   §4 the projections every surface reads (displayed level · selectable
//      stops · the wire's requested string) agree with the truth
//   §5 the shape
//
//  Run:  ~/.bun/bin/bun run scripts/model-routing/prove-effort-vocabulary-truth.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const key of ['OPENAI_API_KEY', 'ZAI_API_KEY', 'MERCURY_CONFIG_DIR', 'MERCURY_AUTH_SCOPE_DIR', 'MERCURY_EFFORT_LEVEL', 'MERCURY_OPENAI_API_BASE']) {
  delete process.env[key]
}
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-effort-vocab-'))
process.env.MERCURY_OPENAI_API_BASE = 'http://127.0.0.1:9'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const effort = await import('../../src/utils/effort.ts')
const wire = await import('../../src/services/providers/openaicompat/compatWire.ts')
const { glmEffortsFor, glmAcceptsEffort } = await import('../../src/services/providers/zai/glmPins.ts')
const { nearestSupportedWireEffort } = await import('../../src/services/providers/openai/gptPins.ts')
const { KIMI_EFFORTS } = await import('../../src/services/providers/moonshot/kimiPins.ts')
const { DEEPSEEK_EFFORTS } = await import('../../src/services/providers/deepseek/deepseekPins.ts')

type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
/** The label the truth prints when the wire carries no key. */
const PROVIDER_DEFAULT_LABEL = 'default'

/** What the compat wire builders put on the wire for a request. */
const moonshotWire = (request: string | undefined): string | undefined =>
  (wire.buildMoonshotExtras({ wireModel: 'kimi-k3', effortValue: request, thinkingEnabled: true, maxOutputTokensOverride: undefined }) as { reasoning_effort?: string }).reasoning_effort
const deepseekWire = (request: string | undefined): string | undefined =>
  ((wire.buildDeepseekExtras({ wireModel: 'deepseek-v4-flash', effortValue: request, thinkingEnabled: true, maxOutputTokensOverride: undefined }) as { thinking?: { reasoning_effort?: string } }).thinking ?? {}).reasoning_effort
/** The zai wire's own expression (zaiCallModel) for a glm id. */
const glmWire = (model: string, request: string | undefined): string | undefined => {
  const vocabulary = glmEffortsFor(model)
  return request && vocabulary ? (glmAcceptsEffort(model, request) ? request : nearestSupportedWireEffort(request, [...vocabulary])) : undefined
}

console.log('the effort truth names the tier the wire carries — documented-vocabulary lanes')

// ── §1 Kimi K3 ──────────────────────────────────────────────────────────────
section('§1 Kimi K3: the truth steps through the wire\'s vocabulary (low | high | max)')
{
  const medium = effort.resolveEffortTruth('kimi-k3', 'medium')
  check("MEDIUM DISPATCHES LOW, AND THE TRUTH SAYS SO (the base displayed 'medium')", medium.wire === 'low' && medium.label === 'low' && medium.applied === 'low', JSON.stringify(medium))
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

// ── §2 DeepSeek ─────────────────────────────────────────────────────────────
section('§2 DeepSeek: the same law on the second lane')
{
  for (const level of LEVELS) {
    const truth = effort.resolveEffortTruth('deepseek-v4-flash', level)
    check(`${level}: truth.wire ≡ the builder's thinking.reasoning_effort`, truth.wire === deepseekWire(level), `${String(truth.wire)} vs ${String(deepseekWire(level))}`)
    check(`${level}: the label IS the wire tier`, truth.label === truth.wire)
  }
  const medium = effort.resolveEffortTruth('deepseek-v4-pro', 'medium')
  check("medium on DeepSeek Pro ⇒ low, adjusted from medium (the base said 'medium')", medium.wire === 'low' && medium.adjustedFrom === 'medium' && medium.label === 'low')
  check('the selectable stops are low | high | max', JSON.stringify(medium.selectable) === JSON.stringify([...DEEPSEEK_EFFORTS].filter(l => LEVELS.includes(l as Level))))
  const numeric = effort.resolveEffortTruth('deepseek-v4-flash', 50)
  check('a numeric request is not a documented word: no key, provider default', numeric.wire === undefined && numeric.label === PROVIDER_DEFAULT_LABEL)
}

// ── §3 GLM per model ────────────────────────────────────────────────────────
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

// ── §4 the projections ──────────────────────────────────────────────────────
section('§4 the projections every surface reads agree with the truth')
{
  check("the chip's word for medium on kimi-k3 is low", effort.getDisplayedEffortLevel('kimi-k3', 'medium') === 'low')
  check("the chip's word for xhigh on glm-5.3 is high", effort.getDisplayedEffortLevel('glm-5.3', 'xhigh') === 'high')
  check('the applied value follows the wire', effort.resolveAppliedEffort('deepseek-v4-flash', 'medium') === 'low')
  check('the selectable stops on kimi-k3 carry no medium', !effort.selectableEffortLevels('kimi-k3').includes('medium'))
  check("the wire's requested string stays the REQUEST (the builders step it themselves — one table, two readers)", effort.resolveWireRequestedEffort('kimi-k3', 'medium') === 'medium')
  // The GPT catalogue and the first-party ladder are untouched by the branch.
  const sonnet = effort.resolveEffortTruth('claude-sonnet-5', 'medium')
  check('a first-party id still rides the ladder (medium stays medium)', sonnet.catalogue === 'static-tables' && sonnet.wire === 'medium', JSON.stringify(sonnet))
}

// ── §5 the shape ────────────────────────────────────────────────────────────
section('§5 the shape')
{
  const src = readFileSync(join(ROOT, 'src/utils/effort.ts'), 'utf8')
  const edge = readFileSync(join(ROOT, 'src/utils/model/capabilities.ts'), 'utf8')
  check('one vocabulary owner feeds the truth (the capability edge, read by the resolution)', /export function effortVocabularyFor\(model: string\): EffortVocabularyView/.test(edge) && /const view = effortVocabularyFor\(model\)/.test(src))
  check('the owner reads the per-model GLM vocabulary, never the union', /glmEffortsFor\(model\)/.test(edge) && !/GLM_EFFORTS\b/.test(edge) && !/GLM_EFFORTS\b/.test(src))
  check('the truth steps nearest-below through the vocabulary', /nearestSupportedWireEffort\(request, \[\.\.\.vocabulary\]\)/.test(src))
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-effort-vocabulary-truth${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
