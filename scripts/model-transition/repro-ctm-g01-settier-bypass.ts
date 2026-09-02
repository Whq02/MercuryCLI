#!/usr/bin/env bun
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

const result = await SetTierTool.call(
  { model: 'sonnet', scope: 'session', reason: 'repro driver: session tier change' },
  context as never,
)
const out = (result as { data: { ok: boolean; appliedModel?: string } }).data
check('tool call applied a session tier change', out.ok === true && !!out.appliedModel, JSON.stringify(out))

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

const pendingAfter = appState.pendingModelSwitch as { setting: string } | null
check(
  '§B REPRODUCED: stale pending switch survives the applied transition',
  pendingAfter !== null && pendingAfter.setting === PARKED.setting,
  JSON.stringify(pendingAfter),
)

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
