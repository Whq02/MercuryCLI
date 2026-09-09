#!/usr/bin/env bun

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
const MACRO_KEY = 'MACRO' as const
;(globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
const src = (...p: string[]) =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' AUTOPILOT mode machinery — carousel · schema · predicate')
console.log('============================================================')

delete process.env.MERCURY_AUTOPILOT
delete process.env.MERCURY_AUTOPILOT_MODELS

const { isAutopilotEnabled, autopilotAllowedModels } = await import(
  '../../src/utils/autopilot/autopilotGates.js'
)
const { getNextPermissionMode } = await import(
  '../../src/utils/permissions/getNextPermissionMode.js'
)
const {
  modeBypassesPermissions,
  permissionModeTitle,
  permissionModeSymbol,
  toExternalPermissionMode,
  permissionModeFromString,
} = await import('../../src/utils/permissions/PermissionMode.js')
const { INTERNAL_PERMISSION_MODES } = await import(
  '../../src/types/permissions.js'
)

section('§1 gates — default-OFF opt-in, live re-read, validated allowlist')
check('unset ⇒ OFF (operator ruling: default-OFF)', isAutopilotEnabled() === false)
process.env.MERCURY_AUTOPILOT = '1'
check("'1' arms (live re-read)", isAutopilotEnabled() === true)
process.env.MERCURY_AUTOPILOT = '0'
check("'0' disarms (live re-read)", isAutopilotEnabled() === false)
process.env.MERCURY_AUTOPILOT = '1'
check('default allowlist = opus,sonnet,fable,fable51 (the frontier default tier, both spellings)', autopilotAllowedModels().join(',') === 'opus,sonnet,fable,fable51')
process.env.MERCURY_AUTOPILOT_MODELS = 'opus,sonnet,fable'
check('operator CSV admits fable', autopilotAllowedModels().includes('fable'))
process.env.MERCURY_AUTOPILOT_MODELS = 'haiku,gpt5,,junk'
check('all-unknown keys ⇒ the EMPTY allowlist (a garbled narrowing narrows)', autopilotAllowedModels().length === 0)
process.env.MERCURY_AUTOPILOT_MODELS = 'opus;sonnet'
check("FC-155: the sibling ';' separator is forgiven — the intent lands", autopilotAllowedModels().join(',') === 'opus,sonnet')
process.env.MERCURY_AUTOPILOT_MODELS = 'opus sonnet'
check('FC-155: the space separator is forgiven too', autopilotAllowedModels().join(',') === 'opus,sonnet')
process.env.MERCURY_AUTOPILOT_MODELS = '"opus"'
check('FC-155: stray surrounding quotes are stripped', autopilotAllowedModels().join(',') === 'opus')
process.env.MERCURY_AUTOPILOT_MODELS = 'SONNET'
check('case-normalized single key honored', autopilotAllowedModels().join(',') === 'sonnet')
delete process.env.MERCURY_AUTOPILOT_MODELS

section('§2 carousel — bypass → autopilot(flag ∧ available) → default')
const ctx = (mode: string, bypassAvail: boolean) => ({
  mode,
  isBypassPermissionsModeAvailable: bypassAvail,
  isAutoModeAvailable: false,
})
process.env.MERCURY_AUTOPILOT = '1'
check('flag ON + bypass available: bypass → autopilot', getNextPermissionMode(ctx('sovereign', true) as never) === 'autopilot')
check('autopilot wraps to default', getNextPermissionMode(ctx('autopilot', true) as never) === 'default')
check('flag ON + bypass NOT available: bypass → default (availability can never exceed bypass)', getNextPermissionMode(ctx('sovereign', false) as never) === 'default')
delete process.env.MERCURY_AUTOPILOT
check('flag OFF: bypass → default (default cycle — byte-identical)', getNextPermissionMode(ctx('sovereign', true) as never) === 'default')

section('§3 schema + config — mode member, bypass family, TRUE external posture')
process.env.MERCURY_AUTOPILOT = '1'
check("'autopilot' ∈ INTERNAL_PERMISSION_MODES", (INTERNAL_PERMISSION_MODES as readonly string[]).includes('autopilot'))
check('permissionModeFromString round-trips', permissionModeFromString('autopilot') === 'autopilot')
check("title 'Autopilot'", permissionModeTitle('autopilot' as never) === 'Autopilot')
check("symbol '⌖' (the self-steering reticle — the Mercury mode-seal family)", permissionModeSymbol('autopilot' as never) === '⌖')
check("external = 'sovereign' (persistence/SDK see the true posture)", toExternalPermissionMode('autopilot' as never) === 'sovereign')

section('§4 the ONE bypass-semantics predicate')
check('sovereign ⇒ true', modeBypassesPermissions('sovereign' as never) === true)
check('autopilot ⇒ true', modeBypassesPermissions('autopilot' as never) === true)
for (const m of ['default', 'implement', 'strategy', 'flow', 'dontAsk']) {
  check(`${m} ⇒ false`, modeBypassesPermissions(m as never) === false)
}

section('§5 parity wiring (structural) — every extended site routes the predicate')
const parityPins: Array<[string, string[], string]> = [
  ['utils/permissions/decision/engine.ts', ['modeBypassesPermissions(permissionContext.mode)'], 'the main permission flow (the owned decision engine, postureBypassesAsks)'],
  ['tools/BashTool/modeValidation.ts', ['modeBypassesPermissions(toolPermissionContext.mode)'], 'bash mode-validation skip'],
  ['tools/PowerShellTool/modeValidation.ts', ['modeBypassesPermissions(toolPermissionContext.mode)'], 'the win32 twin'],
  ['tools/BashTool/bashPermissions.ts', ['modeBypassesPermissions(toolPermissionContext.mode)) return undefined', 'modeBypassesPermissions(toolPermissionContext.mode)) return false'], 'both classifier-spend guards'],
  ['services/PromptSuggestion/speculation.ts', ['isSpeculationEnabled', 'deliberately NOT built'], 'speculative lane disabled-world surface'],
  ['utils/swarm/spawnUtils.ts', ['modeBypassesPermissions(permissionMode)'], 'teammate spawn inheritance'],
  ['tools/shared/spawnMultiAgent.ts', ['modeBypassesPermissions(permissionMode)'], 'multi-agent spawn inheritance'],
  ['tools/AgentTool/agentPermissionPosture.ts', ['!modeBypassesPermissions(parentMode'], 'agent-mode override exclusion (the one posture owner)'],
  ['utils/permissions/permissionSetup.ts', ['modeBypassesPermissions(currentContext.mode)'], 'org-policy kill downgrades autopilot too'],
  ['main.tsx', ['setSessionBypassPermissionsMode(modeBypassesPermissions(permissionMode))', 'modeBypassesPermissions(args.permissionMode) || args.allowDangerousSkip'], 'boot latch + org-policy kill trigger'],
  ['setup.ts', ['modeBypassesPermissions(permissionMode) ||'], 'root/sudo guard'],
  ['interactiveHelpers.tsx', ['modeBypassesPermissions(permissionMode) || allowDangerouslySkipPermissions'], 'launch consent dialog'],
  ['commands/authority/authority.tsx', ['modeBypassesPermissions('], 'authority panel honesty'],
  ['utils/permissionBypassBridge.ts', ["opts?.bypassMode === 'autopilot'"], 'sovereign honesty bridge'],
]
for (const [file, needles, why] of parityPins) {
  const text = src(...file.split('/'))
  for (const needle of needles) {
    check(`${file} — ${why}`, text.includes(needle), `missing: ${needle}`)
  }
}

section('§6 boot + SDK entry guards (structural) — no consent backdoor')
const setupSrc = src('utils', 'permissions', 'permissionSetup.ts')
check('initialPermissionModeFromCLI guards autopilot: flag', setupSrc.includes("if (mode === 'autopilot')") && setupSrc.includes('if (!isAutopilotEnabled())'))
check('initialPermissionModeFromCLI guards autopilot: settings or policy disable', setupSrc.includes('if (sovereignDisabled) {\n        notification = settingsNotice'))
check('initialPermissionModeFromCLI guards autopilot: launch flag required', setupSrc.includes('if (!dangerouslySkipPermissions)'))
check('explicit CLI autopilot + launch flag boots autopilot first (bypass fallback)', setupSrc.includes("if (requested === 'autopilot') candidates.push('autopilot')"))
const runtimeGuard = setupSrc.includes("mode === 'autopilot'") && setupSrc.includes('Cannot set permission mode to autopilot because the session was not launched with --dangerously-bypass-permissions')
check('setPermissionModeWithGuards: full bypass eligibility required at runtime', runtimeGuard)
const ctrlSrc = src('cli', 'headless', 'controlHandlers.ts')
check('SDK setPermissionMode refuses autopilot (interactive-only mode)', ctrlSrc.includes('Cannot set permission mode to autopilot in SDK/print mode'))
check(
  'the refusal is gated on the worker role stamp; the seat runs the ONE eligibility owner',
  /mode === 'autopilot'[\s\S]{0,900}MERCURY_CONCOURSE_WORKER[\s\S]{0,900}validateModeEntry\('autopilot', toolPermissionContext\)/.test(ctrlSrc),
)
const headlessSrc = src('daemon', 'headlessRun.ts')
check('HeadlessPermissionMode union excludes autopilot (daemon workers unreachable)', !headlessSrc.includes("'autopilot'"))

console.log(`\n${failures === 0 ? 'GREEN' : `RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
