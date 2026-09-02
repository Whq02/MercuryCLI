#!/usr/bin/env bun
// ============================================================================
//  scripts/autopilot/prove-settier.ts
//  PROOF: the SetTier rails (tierState) + the tool's pool/wiring seams.
//
//   §1 REFUSAL TABLE: nothing-to-change · reason floor · unknown key (haiku
//      unrepresentable) · fable w/o allowlist · session cap · cooldown
//      (advanced by REAL turn ends only).
//   §2 CLAMP + RESOLVE: effort clamped to the TARGET model's ceiling;
//      resolveTierKey preserves the session's [1m] posture.
//   §3 TURN SLOT: thread-keyed override apply/revert; tierTurnEnded reverts
//      the slot and advances the main cooldown clock; agent threads never
//      advance the main clock.
//   §4 LINE SHAPE: the ⇅ from→to transcript line (spec pin).
//   §5 POOL + WIRING (structural): registry spread flag-gated; toolPool
//      narrows by mode; SetTier isEnabled fork∧flag∧interactive; validateInput
//      rejects subagents + non-autopilot; query.ts applies model/effort at the
//      assembly points and reverts in the finally.
//
//  Run:  ~/.bun/bin/bun run scripts/autopilot/prove-settier.ts
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' SetTier rails + wiring — refusals · clamp · turn slot · pool')
console.log('============================================================')

delete process.env.MERCURY_AUTOPILOT
delete process.env.MERCURY_AUTOPILOT_MODELS

const {
  validateTierChange,
  recordSwitch,
  setTurnOverride,
  applyTurnTierModel,
  applyTurnTierEffort,
  tierTurnEnded,
  describeTurnOverride,
  resolveTierKey,
  resetTierStateForTests,
  MAX_SWITCHES_PER_SESSION,
  TURNS_BETWEEN_SWITCHES,
} = await import('../../src/utils/autopilot/tierState.js')
const { getMaxSupportedEffortLevel } = await import('../../src/utils/effort.js')
const { getDefaultOpusModel, getDefaultSonnetModel } = await import(
  '../../src/utils/model/model.js'
)

const OPUS = getDefaultOpusModel()
const SONNET = getDefaultSonnetModel()
const REASON = 'long mechanical sweep ahead'

section('§1 refusal table')
resetTierStateForTests()
let v = validateTierChange({ scope: 'turn', reason: REASON }, OPUS)
check('nothing-to-change refused', !v.ok && v.refused.includes('nothing to change'))
v = validateTierChange({ model: 'sonnet', scope: 'turn', reason: 'x' }, OPUS)
check('reason floor (surfaced to the operator)', !v.ok && v.refused.includes('reason'))
v = validateTierChange({ model: 'haiku' as never, scope: 'turn', reason: REASON }, OPUS)
check('haiku unrepresentable (closed table)', !v.ok && v.refused.includes('closed table'))
// fable is IN the default allowlist now (the frontier default tier);
// the refusal path is exercised by an operator-NARROWED allowlist.
process.env.MERCURY_AUTOPILOT_MODELS = 'opus,sonnet'
v = validateTierChange({ model: 'fable', scope: 'turn', reason: REASON }, OPUS)
check('fable outside a narrowed allowlist refused (names the env)', !v.ok && v.refused.includes('MERCURY_AUTOPILOT_MODELS'))
delete process.env.MERCURY_AUTOPILOT_MODELS
v = validateTierChange({ model: 'fable', scope: 'turn', reason: REASON }, OPUS)
check('fable accepted under the default allowlist', v.ok)

resetTierStateForTests()
recordSwitch()
v = validateTierChange({ model: 'sonnet', scope: 'turn', reason: REASON }, OPUS)
check('cooldown refuses right after a switch', !v.ok && v.refused.includes('cooldown'))
tierTurnEnded(undefined)
tierTurnEnded(undefined)
v = validateTierChange({ model: 'sonnet', scope: 'turn', reason: REASON }, OPUS)
check(`cooldown still holds after ${TURNS_BETWEEN_SWITCHES - 1} turns`, !v.ok)
tierTurnEnded(undefined)
v = validateTierChange({ model: 'sonnet', scope: 'turn', reason: REASON }, OPUS)
check(`cooldown clears after ${TURNS_BETWEEN_SWITCHES} REAL turn ends`, v.ok)

resetTierStateForTests()
for (let i = 0; i < MAX_SWITCHES_PER_SESSION; i++) recordSwitch()
// advance well past the cooldown so ONLY the cap can refuse
for (let i = 0; i < TURNS_BETWEEN_SWITCHES + 1; i++) tierTurnEnded(undefined)
v = validateTierChange({ model: 'sonnet', scope: 'turn', reason: REASON }, OPUS)
check(`session cap (${MAX_SWITCHES_PER_SESSION}) refuses`, !v.ok && v.refused.includes('cap'))

section('§2 clamp + resolve')
resetTierStateForTests()
const sonnetCeiling = getMaxSupportedEffortLevel(SONNET)
v = validateTierChange({ model: 'sonnet', effort: 'max', scope: 'turn', reason: REASON }, OPUS)
check(
  `effort clamped to the TARGET model ceiling (sonnet: ${sonnetCeiling})`,
  v.ok && v.applied.effort === sonnetCeiling,
)
const opusCeiling = getMaxSupportedEffortLevel(OPUS)
resetTierStateForTests()
v = validateTierChange({ effort: 'max', scope: 'turn', reason: REASON }, OPUS)
check(`effort-only clamps against the CURRENT model (opus: ${opusCeiling})`, v.ok && v.applied.effort === opusCeiling)
check('resolveTierKey preserves [1m] posture', resolveTierKey('sonnet', `${OPUS}[1m]`).endsWith('[1m]'))
check('resolveTierKey plain stays plain', !resolveTierKey('sonnet', OPUS).endsWith('[1m]'))

section('§3 the turn slot — thread-keyed apply + revert')
resetTierStateForTests()
setTurnOverride(undefined, { model: SONNET, effort: 'medium' })
check('main model override applies', applyTurnTierModel(undefined, OPUS) === SONNET)
check('main effort override applies', applyTurnTierEffort(undefined, 'high') === 'medium')
check('an agent thread is NOT affected (thread-keyed)', applyTurnTierModel('agent-1', OPUS) === OPUS)
check('readout present while live', describeTurnOverride(undefined) !== null)
tierTurnEnded(undefined)
check('turn end reverts the model', applyTurnTierModel(undefined, OPUS) === OPUS)
check('turn end reverts the effort', applyTurnTierEffort(undefined, 'high') === 'high')
check('readout null after revert', describeTurnOverride(undefined) === null)
resetTierStateForTests()
recordSwitch()
tierTurnEnded('agent-7')
v = validateTierChange({ model: 'sonnet', scope: 'turn', reason: REASON }, OPUS)
check('agent-thread turn ends do NOT advance the main cooldown clock', !v.ok && v.refused.includes('cooldown'))

section('§4 the ⇅ from→to line (spec pin)')
resetTierStateForTests()
v = validateTierChange({ model: 'sonnet', effort: 'medium', scope: 'turn', reason: 'bulk edits' }, `${OPUS}[1m]`, 'high')
check('line: ⇅ autopilot · <from> → <to> (scope) — reason', v.ok && v.line.startsWith('⇅ autopilot · ') && v.line.includes(' → ') && v.line.includes('(turn) — bulk edits'))
check('line strips [1m] for display', v.ok && !v.line.includes('[1m]'))
check('line carries the from-effort', v.ok && v.line.includes('@high'))

section('§5 pool + wiring (structural)')
const toolsSrc = src('tools.ts')
check('registry spread flag-gated (live)', toolsSrc.includes('...(isAutopilotEnabled() ? [SetTierTool] : [])'))
const poolSrc = src('utils', 'toolPool.ts')
check("toolPool narrows SetTier when mode !== 'autopilot'", poolSrc.includes("mode !== 'autopilot'") && poolSrc.includes('SET_TIER_TOOL_NAME'))
const toolSrc = src('tools', 'SetTierTool', 'SetTierTool.ts')
check('isEnabled = flag ∧ interactive ', toolSrc.includes('isAutopilotEnabled()') && toolSrc.includes('!getIsNonInteractiveSession()'))
check('validateInput rejects subagents', toolSrc.includes('if (context.agentId)'))
check("validateInput rejects non-autopilot mode (live read)", toolSrc.includes("mode !== 'autopilot'"))
check('call() re-checks the mode at execution (shift+tab race)', toolSrc.includes("appState.toolPermissionContext.mode !== 'autopilot'"))
// the session arm does not hand-mirror the
// picker's write — it SETTLES through the one owner (settleModelSelection),
// the same patch + exactly-once receipt every apply path mints; the owner's
// applied patch carries mainLoopModelForSession: null and clears a parked
// pendingModelSwitch (the stale-pending law the hand-rolled write violated).
check(
  'session scope settles through the ONE owner (settleModelSelection, autopilot-tool boundary)',
  toolSrc.includes('settleModelSelection(prev') && toolSrc.includes("boundary: 'autopilot-tool'"),
)
// Module-scoped: the turn assembly lives in the run-core TurnMachine since
// the native-core T8 cut; query.ts keeps the wrapper lifecycle (the finally).
const querySrc =
  src('query.ts') + src('run-core', 'turn-machine.ts')
check('the turn MODEL override lands at the assembly point', querySrc.includes('applyTurnTierModel(toolUseContext.agentId, currentModel)'))
check('the turn EFFORT override applies for turn-owning sources (post-floor shape)', /isTurnOwningQuerySource\(run\.querySource\)\s*\?\s*applyTurnTierEffort\(toolUseContext\.agentId/.test(querySrc))
check("query.ts reverts in the finally (the ultrathink lifecycle)", querySrc.includes('tierTurnEnded(params.toolUseContext.agentId)'))
const frameSrc = src('components', 'MercuryFrame.tsx')
check('MercuryFrame modeBand renders the autopilot band + live tier', frameSrc.includes("permMode === 'autopilot'") && frameSrc.includes('describeTurnOverride(undefined)'))
const promptsSrc = src('constants', 'prompts.ts')
check('modeSections composes the autopilot appendix', promptsSrc.includes('getAutopilotModeSections(permissionMode)'))
// Law 9 hoisted the prompt build behind fetchSystemPromptParts (one owner in
// queryContext.ts); the three session shapes — live turn (QueryEngine),
// compact, background side-question — each thread the LIVE mode there, and
// the owner forwards it to getSystemPrompt (the next-turn law at the
// standing sites; the REPL build sites are the retired estate).
check(
  'every prompt-build caller threads the LIVE toolPermissionContext.mode (live turn, compact, background)',
  /permissionMode: appStateSnapshot\.toolPermissionContext\.mode/.test(src('QueryEngine.ts')) &&
    /permissionMode: context\.getAppState\(\)\.toolPermissionContext\.mode/.test(src('commands', 'compact', 'compact.ts')) &&
    /permissionMode: appState\.toolPermissionContext\.mode/.test(src('utils', 'queryContext.ts')),
)
check(
  'the one owner forwards the mode into getSystemPrompt',
  src('utils', 'queryContext.ts').includes('getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients, permissionMode)'),
)

console.log(`\n${failures === 0 ? 'GREEN' : `RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
