#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-g01-settier-bypass.ts —
//  expect-red driver (bind defect D1: SetTierTool bypasses the settlement
//  owner).
//
//  Mechanism under test: W1 made settleModelSelection the ONE
//  settlement owner — every apply path writes ITS patch and mints ITS
//  receipt, and the owner's 'applied' patch ALWAYS clears
//  pendingModelSwitch (exactly-once application; stale-pending law).
//  SetTierTool's scope:'session' arm hand-rolls the state write instead
//  (SetTierTool.ts `lastModelTransition: {...} satisfies
//  ModelTransitionReceipt`): it spreads the receipt into AppState without
//  calling the owner, and NEVER touches pendingModelSwitch — the exact
//  second-local-version class closed, alive inside the family.
//
//  This driver calls the REAL tool (SetTierTool.call) against an AppState
//  carrying a parked pending switch — the autopilot-mid-queue shape — and
//  records the divergence from the owner's settlement:
//
//    §A the owner's truth: settleModelSelection('applied') clears
//       pendingModelSwitch in the same patch
//    §B DEFECT: the tool's write applies a session model change and leaves
//       the stale pending switch live (it will fire at the next turn
//       boundary and silently override the tool's own choice)
//    §C DEFECT: the tool parks an 'applied' receipt WHILE a pending switch
//       stays live — a state the owner can never produce
//
//  Exit 0 = defect REPRODUCED.
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g01-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g01-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { SetTierTool } = await import('../../src/tools/SetTierTool/SetTierTool.ts')
const { settleModelSelection } = await import('../../src/utils/model/modelTransition.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// The autopilot-mid-queue AppState shape: a pending cross-provider switch is
// parked (the operator picked gpt mid-turn; the boundary has not fired).
const PARKED = { setting: 'gpt-5.2' }
let appState: Record<string, unknown> = {
  toolPermissionContext: { mode: 'autopilot' },
  mainLoopModel: 'claude-opus-5',
  mainLoopModelForSession: null,
  pendingModelSwitch: { ...PARKED },
  lastModelTransition: null,
  effortValue: 'high',
}
const context = {
  agentId: undefined,
  getAppState: () => appState,
  setAppState: (updater: (prev: typeof appState) => typeof appState) => {
    appState = updater(appState)
  },
  options: { mainLoopModel: 'claude-opus-5' },
}

// Drive the REAL tool: a session-scope tier change to sonnet.
const result = await SetTierTool.call(
  { model: 'sonnet', scope: 'session', reason: 'repro driver: session tier change' },
  context as never,
)
const out = (result as { data: { ok: boolean; appliedModel?: string } }).data
check('tool call applied a session tier change', out.ok === true && !!out.appliedModel, JSON.stringify(out))

// §A — the owner's truth for the SAME transition: 'applied' clears pending.
const owner = settleModelSelection(
  {
    mainLoopModel: 'claude-opus-5',
    mainLoopModelForSession: null,
    pendingModelSwitch: { ...PARKED },
    lastModelTransition: null,
  },
  out.appliedModel ?? null,
  { turnActive: false, boundary: 'autopilot-tool' },
)
check(
  "§A owner settlement is 'applied' and clears pendingModelSwitch in the same patch",
  owner.kind === 'applied' && owner.patch !== null && owner.patch.pendingModelSwitch === null,
  `owner.kind=${owner.kind}`,
)

// §B — DEFECT: the tool's hand-rolled write left the stale pending switch live.
const pendingAfter = appState.pendingModelSwitch as { setting: string } | null
check(
  '§B REPRODUCED: stale pending switch survives the applied transition',
  pendingAfter !== null && pendingAfter.setting === PARKED.setting,
  JSON.stringify(pendingAfter),
)

// §C — DEFECT: 'applied' receipt parked WHILE pending stays live — the owner
// can never produce this combination (every owner patch that writes an
// applied receipt also nulls pendingModelSwitch).
const receipt = appState.lastModelTransition as { resolution?: string } | null
check(
  "§C REPRODUCED: an 'applied' receipt coexists with a live pending switch",
  receipt?.resolution === 'applied' && pendingAfter !== null,
  `resolution=${receipt?.resolution}`,
)

console.log(
  failed === 0
    ? '\n REPRODUCED — G01 red recorded (SetTierTool writes outside the settlement owner)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
