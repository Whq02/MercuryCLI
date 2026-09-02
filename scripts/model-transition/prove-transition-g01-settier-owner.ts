#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/prove-transition-g01-settier-owner.ts —
//  SetTierTool settles through the ONE owner (settleModelSelection).
//
//  Drives the REAL tool (SetTierTool.call) against the autopilot-mid-queue
//  state the expect-red used (repro-ctm-g01-settier-bypass — now retired):
//
//    §A model change with a parked pending switch → the owner's applied
//       patch: model applied, pendingModelSwitch CLEARED in the same
//       update, exactly-once receipt (resolution 'applied', boundary
//       'autopilot-tool')
//    §B effort-only change → NO model settlement: a parked switch stays
//       parked, no new receipt, effortValue updated (an effort tweak is
//       not a model re-choice)
//    §C re-picking the CURRENT tier with a parked switch → the owner's
//       SAME-MODEL NO-OP law: pending cleared WITH a 'cancelled-pending'
//       receipt (a queued transition resolved)
//    §D the never-again invariant across every observed state: an
//       'applied' receipt never coexists with a live pending switch
//
//  Rails note: the prover advances the tier-turn counter between calls
//  (tierTurnEnded ×3) — the cooldown is real and stays real.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ctm-g01p-config-'))
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'ctm-g01p-home-'))
process.env.ANTHROPIC_API_KEY = 'fixture-key'

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()

const { SetTierTool } = await import('../../src/tools/SetTierTool/SetTierTool.ts')
const { tierTurnEnded, resolveTierKey } = await import('../../src/utils/autopilot/tierState.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

type Receipt = { resolution?: string; boundary?: string; applied?: string | null } | null
interface S {
  toolPermissionContext: { mode: string }
  mainLoopModel: string | null
  mainLoopModelForSession: string | null
  pendingModelSwitch: { setting: string | null } | null
  lastModelTransition: Receipt
  effortValue: string
}
let appState: S = {
  toolPermissionContext: { mode: 'autopilot' },
  mainLoopModel: 'claude-opus-5',
  mainLoopModelForSession: null,
  pendingModelSwitch: { setting: 'gpt-5.2' },
  lastModelTransition: null,
  effortValue: 'high',
}
const context = {
  agentId: undefined,
  getAppState: () => appState,
  setAppState: (updater: (prev: S) => S) => {
    appState = updater(appState)
  },
  options: { mainLoopModel: 'claude-opus-5' },
}
const invariantHolds = () =>
  !(appState.lastModelTransition?.resolution === 'applied' && appState.pendingModelSwitch !== null)
const coolDown = () => {
  for (let i = 0; i < 3; i++) tierTurnEnded(undefined)
}

// §A — model change with a parked pending switch.
const a = await SetTierTool.call(
  { model: 'sonnet', scope: 'session', reason: 'prover: session tier change' },
  context as never,
)
const aOut = (a as { data: { ok: boolean; appliedModel?: string } }).data
check('§A tool applied', aOut.ok === true, JSON.stringify(aOut))
check('§A model written', appState.mainLoopModel === aOut.appliedModel)
check('§A parked pending switch CLEARED in the same update', appState.pendingModelSwitch === null)
check(
  "§A exactly-once receipt: 'applied' at the autopilot-tool boundary",
  appState.lastModelTransition?.resolution === 'applied' &&
    appState.lastModelTransition?.boundary === 'autopilot-tool',
  JSON.stringify(appState.lastModelTransition),
)
check('§D invariant after §A', invariantHolds())

// §B — effort-only change with a parked switch: no settlement.
coolDown()
appState = {
  ...appState,
  pendingModelSwitch: { setting: 'gpt-5.2' },
  lastModelTransition: null,
}
const b = await SetTierTool.call(
  { effort: 'medium', scope: 'session', reason: 'prover: effort-only change' },
  context as never,
)
check('§B tool applied', (b as { data: { ok: boolean } }).data.ok === true)
check('§B effort updated', appState.effortValue === 'medium')
check('§B parked switch stays parked (no model re-choice)', appState.pendingModelSwitch?.setting === 'gpt-5.2')
check('§B no receipt minted', appState.lastModelTransition === null)

// §C — re-picking the CURRENT tier with a parked switch → cancelled-pending.
coolDown()
const currentResolved = resolveTierKey('sonnet', appState.mainLoopModel ?? '')
appState = {
  ...appState,
  mainLoopModel: currentResolved,
  pendingModelSwitch: { setting: 'gpt-5.2' },
  lastModelTransition: null,
}
const c = await SetTierTool.call(
  { model: 'sonnet', scope: 'session', reason: 'prover: re-pick current tier' },
  context as never,
)
check('§C tool call ok', (c as { data: { ok: boolean } }).data.ok === true)
check('§C pending cleared by the SAME-MODEL NO-OP law', appState.pendingModelSwitch === null)
check(
  "§C 'cancelled-pending' receipt minted (a queued transition resolved)",
  appState.lastModelTransition?.resolution === 'cancelled-pending',
  JSON.stringify(appState.lastModelTransition),
)
check('§D invariant after §C', invariantHolds())

console.log(
  failures === 0
    ? '\n ✅ SETTIER SETTLES THROUGH THE OWNER (applied · effort-only · cancelled-pending)'
    : `\n ❌ ${failures} FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
