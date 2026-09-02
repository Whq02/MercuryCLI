#!/usr/bin/env bun
// ============================================================================
//  scripts/model-registry/prove-frontier-wire-laws.ts — the two wire laws
//  Claude Fable 5.1 brought to the frontier family (the newest catalogue
//  row), pinned at their ONE owners and at both Anthropic wire
//  builders:
//
//  §1 FORCED TOOL CHOICE folds to `auto` on the models that reject it:
//     Claude Fable 5.1 (its Mythos 5.1 mirror through the canonical) returns
//     a 400 on tool_choice `any` / `tool`. Every other model keeps the
//     caller's choice verbatim (Fable 5 included); `auto`, `none` and an
//     absent choice never move anywhere; a carrier-shaped row never joins the
//     first-party fold.
//  §2 THINKING IS ALWAYS ON for the family (Fable 5 / 5.1, the Mythos
//     mirrors): an explicit disable is OMITTED there (a `disabled` config is
//     a 400 — adaptive runs), a budget rides as adaptive wherever the model
//     is adaptive-capable, and the budget models still take their budget
//     capped under max_tokens.
//  §3 THE WIRING: the main stream and the side query both route tool_choice
//     through the one fold; the side query derives its thinking parameter
//     through the one law; the main stream sends no thinking parameter at
//     all when thinking is off (never the rejected `disabled` shape).
//  §4 THE SECOND MEMBER IS RECOGNISED EVERYWHERE THE FAMILY IS: its own
//     canonical (the Mythos 5.1 mirror folds onto it), the one display
//     owner's name, the exact-generation alias, the router class, the seat
//     allowlist and cycle, natively 1M with 128K out, and every effort
//     answer identical to Fable 5's with the launch default following the
//     family table; the tier-key tables list it beside the family key and
//     the family default never moves.
//
//  Pure: no network, no config home, no build.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Ambient-state hygiene: the canonical fold reads the model-override seams —
// pin them off so the proof never reads the calibration machine.
for (const k of [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_MODEL',
  'MERCURY_DISABLE_1M_CONTEXT',
  'MERCURY_AUTOPILOT_MODELS',
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
const { SEAT_ALLOWED_FAMILIES } = await import('../../src/utils/model/seatSlots.ts')
const { getLaunchDefaultEffort } = await import('../../src/utils/effort.ts')
const { AUTOPILOT_TIER_KEYS, autopilotAllowedModels } = await import('../../src/utils/autopilot/autopilotGates.ts')
const { AGENT_DISPATCH_MODELS, MODEL_ALIASES } = await import('../../src/utils/model/aliases.ts')
const { CREW_MODEL_CHOICES } = await import('../../src/daemon/crewSpawn.ts')

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

// ── §1 forced tool choice ────────────────────────────────────────────────────
section('§1 forced tool_choice folds to auto exactly where the model rejects it')
{
  const rejecting = ['claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-mythos-5-1']
  const accepting = [
    'claude-fable-5',
    'claude-fable-5[1m]',
    'claude-mythos-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-6',
    'claude-haiku-4-5',
    // A carrier-shaped row never joins the first-party fold by substring.
    'openrouter/anthropic/claude-fable-5-1',
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
  // Pure: the fold never mutates the caller's choice.
  check('the fold never mutates the input object', show(forcedTool) === show({ type: 'tool', name: 'classify_result' }))
}

// ── §2 thinking always on ───────────────────────────────────────────────────
section('§2 thinking is always on for the frontier family; the disable is omitted there')
{
  const alwaysOn = ['claude-fable-5', 'claude-fable-5[1m]', 'claude-fable-5-1', 'claude-fable-5-1[1m]', 'claude-mythos-5', 'claude-mythos-5-1']
  const notAlwaysOn = ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5', 'openrouter/anthropic/claude-fable-5-1']
  for (const m of alwaysOn) check(`${m}: thinking always on`, modelThinkingAlwaysOn(m))
  for (const m of notAlwaysOn) check(`${m}: thinking not always on`, !modelThinkingAlwaysOn(m))

  // An explicit disable: OMITTED on the always-on family, `disabled` elsewhere.
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
  // A budget: adaptive wherever the model is adaptive-capable (the one law
  // the main stream applies), the capped budget on the budget models.
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

// ── §3 the wiring ───────────────────────────────────────────────────────────
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
  // The forced-choice callers still name their tool in the prompt — the
  // docs' own replacement for a forced choice, so the fold costs nothing.
  const classifierPrompt = src('src/utils/permissions/auto-mode-classifier-prompts/auto_mode_system_prompt.txt')
  check(
    'the auto-mode classifier prompt names its tool (the forced choice was never load-bearing)',
    classifierPrompt.includes('Use the classify_result tool to report your classification.'),
  )
}

// ── §4 the second member is recognised everywhere the family is ─────────────
section('§4 Claude Fable 5.1 is recognised everywhere the family is; the family default never moves')
{
  const ID = 'claude-fable-5-1'
  const FAMILY = 'claude-fable-5'
  check('its own canonical (never swallowed by the fable-5 substring arm)', getCanonicalName(ID) === ID)
  check('the [1m] twin folds to the same canonical', getCanonicalName(`${ID}[1m]`) === ID)
  check('the Mythos 5.1 mirror folds onto it', getCanonicalName('claude-mythos-5-1') === ID)
  check('Mythos 5 still folds onto Fable 5 (the family default is untouched)', getCanonicalName('claude-mythos-5') === FAMILY)
  check("the one display owner names it 'Fable 5.1'", renderModelName(ID) === 'Fable 5.1', renderModelName(ID))
  check("the exact-generation alias 'fable51' resolves to the bare id", parseUserSpecifiedModel('fable51') === ID, parseUserSpecifiedModel('fable51'))
  check("the family alias 'fable' still resolves to the family default, not the second member", getCanonicalName(parseUserSpecifiedModel('fable')) === FAMILY, parseUserSpecifiedModel('fable'))
  check("the router classifies it 'fable'", classOfModel(ID) === 'fable', String(classOfModel(ID)))
  check('the seat allowlist carries it beside the family default', SEAT_ALLOWED_FAMILIES.includes(ID) && SEAT_ALLOWED_FAMILIES.includes(FAMILY))
  check('natively 1M on the bare id', getContextWindowForModel(ID) === 1_000_000, String(getContextWindowForModel(ID)))
  check('128K output through the family arm of the output table', getModelMaxOutputTokens(ID).upperLimit === 128_000)

  // Effort parity: every answer the effort owners give for the second member
  // equals the family's, and the launch default follows the family table.
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

  // The tier-key tables: the exact-generation key rides beside the family key.
  check("the autopilot key table lists 'fable51' beside 'fable'", (AUTOPILOT_TIER_KEYS as readonly string[]).includes('fable') && (AUTOPILOT_TIER_KEYS as readonly string[]).includes('fable51'))
  check('the default autopilot allowlist admits both (unset env)', (autopilotAllowedModels() as readonly string[]).includes('fable51') && (autopilotAllowedModels() as readonly string[]).includes('fable'))
  check("the subagent dispatch vocabulary and the settings alias list carry 'fable51'", (AGENT_DISPATCH_MODELS as readonly string[]).includes('fable51') && (MODEL_ALIASES as readonly string[]).includes('fable51'))
  check("the crew spawn table carries fable51 → claude-fable-5-1 @ high beside fable → claude-fable-5 @ high", CREW_MODEL_CHOICES.fable51.model === ID && CREW_MODEL_CHOICES.fable51.effort === 'high' && CREW_MODEL_CHOICES.fable.model === FAMILY && CREW_MODEL_CHOICES.fable.effort === 'high')
  const daedalus = src('src/tools/WorkflowTool/bundled/daedalus.ts')
  const roster = src('src/tools/WorkflowTool/workflowPrompt.ts')
  const menu = src('src/substrate/startupMenu.ts')
  check(
    'the DAEDALUS compatible set, the saved-roster aliases and both boot-menu enums list it',
    daedalus.includes("'fable51'") && daedalus.includes("'claude-fable-5-1'") &&
      roster.includes("['opus', 'sonnet', 'fable', 'fable51']") &&
      (menu.match(/options: \['opus', 'sonnet', 'fable', 'fable51'\]/g) ?? []).length === 2,
  )
}

console.log('\n' + '='.repeat(60))
if (failures > 0) {
  console.log(` FAIL — ${failures} frontier-wire-law check(s) failed`)
  process.exit(1)
}
console.log(' ALL FRONTIER-WIRE-LAW PROOFS PASS')
