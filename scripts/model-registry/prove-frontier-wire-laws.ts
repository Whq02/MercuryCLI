#!/usr/bin/env bun
import { mkdtempSync as mkScratch } from 'node:fs'
import { tmpdir as osTmp } from 'node:os'
import { join as pathJoin } from 'node:path'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const proofHome = mkScratch(pathJoin(osTmp(), 'frontier-wire-proof-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) process.env[spelling] = proofHome
for (const key of ['MERCURY_MODEL', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY']) delete process.env[key]
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:1'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
;(await import('../../src/utils/config.js')).enableConfigs()

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

for (const k of [
  'MERCURY_DEFAULT_OPUS_MODEL',
  'MERCURY_DEFAULT_SONNET_MODEL',
  'MERCURY_DEFAULT_FABLE_MODEL',
  'MERCURY_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
]) {
  delete process.env[k]
}

const {
  foldToolChoiceForModel,
  modelSupportsAdaptiveThinking,
  modelSupportsForcedToolChoice,
  modelThinkingAlwaysOn,
} = await import('../../src/utils/model/capabilities.ts')
const { sideQueryThinkingParam } = await import('../../src/utils/sideQuery.ts')
const {
  getContextWindowForModel,
  getMaxSupportedEffortLevel,
  getModelMaxOutputTokens,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXHighEffort,
} = await import('../../src/utils/model/capabilities.ts')
const { getCanonicalName, parseUserSpecifiedModel, renderModelName } = await import('../../src/utils/model/model.ts')
const { classOfModel } = await import('../../src/utils/router/modelRegistry.ts')
const seatSlots = await import('../../src/utils/model/seatSlots.ts')
const { getLaunchDefaultEffort } = await import('../../src/utils/effort.ts')
const { AGENT_DISPATCH_MODELS, MODEL_ALIASES } = await import('../../src/utils/model/aliases.ts')
const { foldLegacyWorkerModelKey } = await import('../../src/services/concourse/workerModels.ts')

let failures = 0
function check(label: string, cond: boolean, detail?: string): void {
  const mark = cond ? 'PASS' : 'FAIL'
  if (!cond) failures++
  console.log(`  [${mark}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log(`\n${title}`)
}
const repoRoot = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf-8')
const show = (v: unknown): string => JSON.stringify(v)

section('§1 forced tool_choice folds to auto exactly where the model rejects it')
{
  const rejecting = ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']
  const accepting = [
    'claude-fable-5',
    'claude-fable-5[1m]',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    'openrouter/anthropic/claude-fable-5-1',
    'openrouter/anthropic/claude-sonnet-5-5',
  ]
  for (const m of rejecting) {
    check(`${m}: forced tool choice unsupported`, !modelSupportsForcedToolChoice(m))
  }
  for (const m of accepting) {
    check(`${m}: forced tool choice supported`, modelSupportsForcedToolChoice(m))
  }

  const forcedTool = { type: 'tool', name: 'classify_result' }
  const forcedAny = { type: 'any' }
  const auto = { type: 'auto' }
  const none = { type: 'none' }
  for (const m of rejecting) {
    check(
      `${m}: {type:'tool'} folds to {type:'auto'}`,
      show(foldToolChoiceForModel(m, forcedTool)) === show({ type: 'auto' }),
      show(foldToolChoiceForModel(m, forcedTool)),
    )
    check(
      `${m}: {type:'any'} folds to {type:'auto'}`,
      show(foldToolChoiceForModel(m, forcedAny)) === show({ type: 'auto' }),
      show(foldToolChoiceForModel(m, forcedAny)),
    )
    check(`${m}: auto passes through as the same object`, foldToolChoiceForModel(m, auto) === auto)
    check(`${m}: none passes through as the same object`, foldToolChoiceForModel(m, none) === none)
    check(`${m}: an absent choice stays absent`, foldToolChoiceForModel(m, undefined) === undefined)
  }
  for (const m of accepting) {
    check(`${m}: {type:'tool'} rides verbatim (same object)`, foldToolChoiceForModel(m, forcedTool) === forcedTool)
    check(`${m}: {type:'any'} rides verbatim (same object)`, foldToolChoiceForModel(m, forcedAny) === forcedAny)
  }
  check('the fold never mutates the input object', show(forcedTool) === show({ type: 'tool', name: 'classify_result' }))
}

section('§2 thinking is always on for the frontier family; the disable is omitted there')
{
  const alwaysOn = ['claude-fable-5', 'claude-fable-5[1m]', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-mythos-5', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5[1m]']
  const notAlwaysOn = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5', 'openrouter/anthropic/claude-fable-5-1', 'openrouter/anthropic/claude-sonnet-5-5']
  for (const m of alwaysOn) check(`${m}: thinking always on`, modelThinkingAlwaysOn(m))
  for (const m of notAlwaysOn) check(`${m}: thinking not always on`, !modelThinkingAlwaysOn(m))

  for (const m of alwaysOn) {
    check(`${m}: thinking=false ⇒ no thinking parameter`, sideQueryThinkingParam(m, false, 4096) === undefined)
  }
  for (const m of notAlwaysOn) {
    check(
      `${m}: thinking=false ⇒ {type:'disabled'}`,
      show(sideQueryThinkingParam(m, false, 4096)) === show({ type: 'disabled' }),
      show(sideQueryThinkingParam(m, false, 4096)),
    )
  }
  for (const m of [...alwaysOn, 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-6']) {
    check(`${m}: adaptive-capable per the owner`, modelSupportsAdaptiveThinking(m))
    check(
      `${m}: thinking=2048 ⇒ {type:'adaptive'} (no budget on the wire)`,
      show(sideQueryThinkingParam(m, 2048, 4096)) === show({ type: 'adaptive' }),
      show(sideQueryThinkingParam(m, 2048, 4096)),
    )
  }
  for (const m of ['claude-haiku-4-5', 'claude-opus-4-5', 'claude-sonnet-4-5']) {
    check(`${m}: a budget model per the owner`, !modelSupportsAdaptiveThinking(m))
    check(
      `${m}: thinking=2048 ⇒ enabled with the budget`,
      show(sideQueryThinkingParam(m, 2048, 4096)) === show({ type: 'enabled', budget_tokens: 2048 }),
      show(sideQueryThinkingParam(m, 2048, 4096)),
    )
    check(
      `${m}: the budget stays under max_tokens (9000 vs 4096 ⇒ 4095)`,
      show(sideQueryThinkingParam(m, 9000, 4096)) === show({ type: 'enabled', budget_tokens: 4095 }),
      show(sideQueryThinkingParam(m, 9000, 4096)),
    )
  }
  for (const m of [...alwaysOn, ...notAlwaysOn]) {
    check(`${m}: absent thinking ⇒ no thinking parameter`, sideQueryThinkingParam(m, undefined, 4096) === undefined)
  }
}

section('§3 both Anthropic wire builders ride the one fold and the one thinking law')
{
  const stream = src('src/services/providers/anthropic/streamCore.ts')
  const side = src('src/utils/sideQuery.ts')
  const caps = src('src/utils/model/capabilities.ts')

  check(
    'capabilities.ts exports the one fold and both predicates',
    caps.includes('export function foldToolChoiceForModel') &&
      caps.includes('export function modelSupportsForcedToolChoice') &&
      caps.includes('export function modelThinkingAlwaysOn'),
  )
  check(
    'the main stream folds the caller tool_choice through the one owner',
    stream.includes('foldToolChoiceForModel(options.model, options.toolChoice)') &&
      stream.includes('tool_choice: toolChoice,'),
  )
  check(
    'the main stream sends NO thinking parameter when thinking is off (never the disabled shape)',
    stream.includes("let thinking: BetaMessageStreamParams['thinking'] | undefined = undefined") &&
      stream.includes('if (hasThinking && modelSupportsThinking(options.model))') &&
      !/thinking\s*=\s*\{\s*type:\s*'disabled'/.test(stream),
  )
  check(
    'the side query folds its tool_choice through the one owner',
    side.includes('foldToolChoiceForModel(opts.model, opts.tool_choice') &&
      side.includes('...(toolChoice ? { tool_choice: toolChoice } : {})'),
  )
  check(
    'the side query derives its thinking parameter through the one law',
    side.includes('export function sideQueryThinkingParam') &&
      side.includes('sideQueryThinkingParam(opts.model, opts.thinking, maxTokens)') &&
      side.includes('...(thinking ? { thinking } : {})'),
  )
  check(
    'the side query never spells the disabled shape outside the law',
    (side.match(/type:\s*'disabled'/g) ?? []).length === 2,
    `${(side.match(/type:\s*'disabled'/g) ?? []).length} spellings (the type union + the law)`,
  )
}

section('§4 Claude Fable 5.1 is recognised everywhere the family is; the family word resolves to the generation table\'s newest')
{
  const ID = 'claude-fable-5-1'
  const FAMILY = 'claude-fable-5'
  check('its own canonical (never swallowed by the fable-5 substring arm)', getCanonicalName(ID) === ID)
  check('the [1m] twin folds to the same canonical', getCanonicalName(`${ID}[1m]`) === ID)
  check('the Mythos 5.1 mirror folds onto it', getCanonicalName('claude-mythos-5-1') === ID)
  check('Mythos 5 still folds onto Fable 5 (the previous generation keeps its own canonical)', getCanonicalName('claude-mythos-5') === FAMILY)
  check("the one display owner names it 'Fable 5.1'", renderModelName(ID) === 'Fable 5.1', renderModelName(ID))
  check("the exact-generation alias 'fable51' resolves to the bare id", parseUserSpecifiedModel('fable51') === ID, parseUserSpecifiedModel('fable51'))
  check("the family alias 'fable' resolves to the generation table's newest row — this member", getCanonicalName(parseUserSpecifiedModel('fable')) === ID, parseUserSpecifiedModel('fable'))
  check("the router classifies it 'fable'", classOfModel(ID) === 'fable', String(classOfModel(ID)))
  check('no seat family allowlist stands beside the worker registry', !('SEAT_ALLOWED_FAMILIES' in seatSlots) && !('validateSeatModel' in seatSlots))
  check('natively 1M on the bare id', getContextWindowForModel(ID) === 1_000_000, String(getContextWindowForModel(ID)))
  check('128K output through the family arm of the output table', getModelMaxOutputTokens(ID).upperLimit === 128_000)

  for (const [label, fn] of [
    ['modelSupportsEffort', modelSupportsEffort],
    ['modelSupportsXHighEffort', modelSupportsXHighEffort],
    ['modelSupportsMaxEffort', modelSupportsMaxEffort],
    ['getMaxSupportedEffortLevel', getMaxSupportedEffortLevel],
  ] as Array<[string, (m: string) => unknown]>) {
    check(`${label}: Fable 5.1 answers as Fable 5 does (${String(fn(FAMILY))})`, fn(ID) === fn(FAMILY), `${String(fn(ID))} vs ${String(fn(FAMILY))}`)
  }
  check('the effort ladder reaches max on both members', getMaxSupportedEffortLevel(ID) === 'max' && modelSupportsXHighEffort(ID))
  check("the launch default follows the family table ('high', Fable 5's own)", getLaunchDefaultEffort(ID) === 'high' && getLaunchDefaultEffort(FAMILY) === 'high')

  check("the subagent dispatch vocabulary and the settings alias list carry 'fable51'", (AGENT_DISPATCH_MODELS as readonly string[]).includes('fable51') && (MODEL_ALIASES as readonly string[]).includes('fable51'))
  check("a crew record's legacy keys fold to it: fable51 and the family word land on the same newest row", foldLegacyWorkerModelKey('fable51') === ID && foldLegacyWorkerModelKey('fable') === ID)
}

section('§5 Claude Sonnet 5.5 answers both laws as recorded on the wire: the disabled shape and a forced choice are refused, the omitted parameter and auto are served')
{
  type Leg = { leg: string; request: Record<string, unknown>; response: { status: number; stop_reason?: string; content?: Array<{ type: string; name?: string }>; error_body?: { error?: { type?: string; message?: string } } } }
  const fixture = JSON.parse(src('scripts/model-registry/fixtures/sonnet-55-wire-probe.json')) as { model: string; legs: Leg[] }
  const ID = 'claude-sonnet-5-5'
  const leg = (name: string): Leg => fixture.legs.find(l => l.leg === name) ?? { leg: name, request: {}, response: { status: 0 } }
  const message = (l: Leg): string => l.response.error_body?.error?.message ?? ''
  const DISABLED_REFUSED = '"thinking.type.disabled" is not supported for this model.'
  const FORCED_REFUSED = 'tool_choice: type "tool" and "any" are not supported for this model.'

  check('the fixture records the row', fixture.model === ID && fixture.legs.length >= 7, `${fixture.model} · ${fixture.legs.length} legs`)
  const disabled = leg('R2')
  check('the recorded request carried the disabled shape the side query spells for a model its gate does not name', show(disabled.request.thinking) === show({ type: 'disabled' }), show(disabled.request))
  check('the wire refused it: 400 invalid_request_error naming thinking.type.disabled and pointing to between_tools', disabled.response.status === 400 && disabled.response.error_body?.error?.type === 'invalid_request_error' && message(disabled).includes(DISABLED_REFUSED) && message(disabled).includes('between_tools'), `${disabled.response.status} ${message(disabled)}`)
  check('so thinking is always on for the row and its twin, and a thinking-off side query sends no thinking parameter', modelThinkingAlwaysOn(ID) && modelThinkingAlwaysOn(`${ID}[1m]`) && sideQueryThinkingParam(ID, false, 4096) === undefined, show(sideQueryThinkingParam(ID, false, 4096)))
  const absent = leg('R1')
  check('the omitted parameter is the served shape: the control without a thinking parameter answered 200', absent.request.thinking === 'absent' && absent.response.status === 200 && absent.response.stop_reason === 'end_turn', `${absent.response.status} ${String(absent.response.stop_reason)}`)

  for (const [name, choice] of [['R3', { type: 'tool', name: 'classify_result' }], ['R4', { type: 'any' }]] as const) {
    const forced = leg(name)
    check(`${name}: the recorded request carried ${show(choice)} verbatim (the fold left it alone on a model its gate did not name)`, show(forced.request.tool_choice) === show(choice), show(forced.request.tool_choice))
    check(`${name}: the wire refused it: 400 invalid_request_error, the vendor's forced-tool-choice words`, forced.response.status === 400 && message(forced) === FORCED_REFUSED, `${forced.response.status} ${message(forced)}`)
  }
  const composed = leg('R6')
  const composedThinking = composed.request.thinking as { type?: string; block_binding?: { prefix_mismatch_behavior?: string } } | undefined
  check("R6: under the main stream's own composition — adaptive thinking with the binding, effort high, the binding beta — a forced choice is refused the same way", composedThinking?.type === 'adaptive' && composedThinking.block_binding?.prefix_mismatch_behavior === 'drop_block' && show(composed.request.output_config) === show({ effort: 'high' }) && (composed.request.betas as string[]).includes('thinking-binding-controls-2026-08-01') && composed.response.status === 400 && message(composed) === FORCED_REFUSED, `${show(composed.request)} → ${composed.response.status} ${message(composed)}`)
  check('so forced tool choice is unsupported on the row and its twin, and the one fold turns tool and any into auto', !modelSupportsForcedToolChoice(ID) && !modelSupportsForcedToolChoice(`${ID}[1m]`) && show(foldToolChoiceForModel(ID, { type: 'tool', name: 'classify_result' })) === show({ type: 'auto' }) && show(foldToolChoiceForModel(ID, { type: 'any' })) === show({ type: 'auto' }))
  const auto = leg('R5')
  check("auto is the served shape: the same tool under tool_choice auto answered 200 and the model called it (the fold's replacement costs nothing)", show(auto.request.tool_choice) === show({ type: 'auto' }) && auto.response.status === 200 && auto.response.stop_reason === 'tool_use' && (auto.response.content ?? []).some(b => b.type === 'tool_use' && b.name === 'classify_result'), `${auto.response.status} ${String(auto.response.stop_reason)}`)
  const composedControl = leg('R7')
  check("the main stream's composition without a forced choice answered 200 (the refusal is the choice's, not the composition's)", composedControl.response.status === 200, String(composedControl.response.status))
  check('Sonnet 5 keeps its own answers: the disabled shape and a forced choice ride there', !modelThinkingAlwaysOn('claude-sonnet-5') && modelSupportsForcedToolChoice('claude-sonnet-5') && show(sideQueryThinkingParam('claude-sonnet-5', false, 4096)) === show({ type: 'disabled' }))
  check('a carrier-shaped spelling of the row never joins either law', !modelThinkingAlwaysOn('openrouter/anthropic/claude-sonnet-5-5') && modelSupportsForcedToolChoice('openrouter/anthropic/claude-sonnet-5-5'))
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} frontier-wire-law check(s) failed`)
  process.exit(1)
}
console.log(' ALL FRONTIER-WIRE-LAW PROOFS PASS')
