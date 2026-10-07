#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}
const src = (...p: string[]): string =>
  readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Permission ladder / auto-mode classifier — surface proof')
console.log('============================================================')

section('the THREE auto-mode safety floors (decision/wrapper.ts) — force a human ask before the shortcuts')
{
  const perms = src('utils', 'permissions', 'decision', 'wrapper.ts')
  const has = (needle: string) => perms.includes(needle)
  check('floor: ask-rule reason → reasonCarriesAskRule', has('function reasonCarriesAskRule') && has('reasonCarriesAskRule(engineDecision.decisionReason)'))
  check("floor: org/MCP ask-ceiling (effectiveMaxPermission === 'ask')", has("tool.mcpInfo?.effectiveMaxPermission === 'ask'"))
  check('floor: Workflow usage-consent → workflowRequiresConsent', has('function workflowRequiresConsent') && has('workflowRequiresConsent(tool.name)'))
  check(
    'the three floors converge on ONE guard before the shortcuts',
    has("floorTags.push('ask-rule')") &&
      has("floorTags.push('org-ceiling')") &&
      has("floorTags.push('workflow-consent')") &&
      has('if (floorTags.length > 0)'),
  )
  const engine = src('utils', 'permissions', 'decision', 'engine.ts')
  check(
    'kill-switch is step 0 of the ladder (per-call agentType)',
    engine.includes('ports.isToolKilled(tool, context.agentType)'),
  )
}

section('isAutoModeAllowlistedTool name/action gating (classifierDecision.ts)')
{
  const cd = src('utils', 'permissions', 'classifierDecision.ts')
  const has = (needle: string) => cd.includes(needle)
  check('exists + gates safe-tool names on the allowlist SET', has('export function isAutoModeAllowlistedTool') && has('SAFE_FLOW_ALLOWLISTED_TOOLS.has(toolName)'))
  const safeSetStart = cd.indexOf('const SAFE_FLOW_ALLOWLISTED_TOOLS: ReadonlySet<string> = new Set([')
  const safeSet = safeSetStart === -1 ? '' : cd.slice(safeSetStart, cd.indexOf('])', safeSetStart))
  check('the safe set carries the read-only tools (positive control)', safeSet.includes('FILE_READ_TOOL_NAME,') && safeSet.includes('GREP_TOOL_NAME,') && safeSet.includes('GLOB_TOOL_NAME,'))
  check('write/edit tools are NOT on the safe set (absence, file-wide)', safeSet.length > 0 && !has('FILE_WRITE_TOOL_NAME,') && !has('FILE_EDIT_TOOL_NAME,'))
}

section('Flow availability uses settings and runtime safety state')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  check('the runtime circuit breaker closes availability', ps.includes('if (isAutoModeCircuitBroken()) return false'))
  check('settings close availability', ps.includes('if (isAutoModeDisabledBySettings()) return false'))
  check('verification updates the circuit breaker from settings', ps.includes('const circuitBroken = disabledBySettings') && ps.includes('autoModeStateModule?.setAutoModeCircuitBroken(circuitBroken)'))
  check('the runtime restriction has an explanatory reason', ps.includes("if (isAutoModeCircuitBroken()) return 'circuit-breaker'"))
  check('explicit availability still requires a supported model', ps.includes('const explicitAvailable = !disabledBySettings && modelSupported'))
  const gnpm = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('the carousel gates auto SOLELY on canCycleToAuto (unconditional)', gnpm.includes('canCycleToAuto(toolPermissionContext)'))
  const apolloBlock = gnpm.slice(gnpm.indexOf("case 'apollo':"), gnpm.indexOf("case 'flow':"))
  const autoIdx = apolloBlock.indexOf("return 'flow'")
  const bypassIdx = apolloBlock.indexOf("return 'sovereign'")
  check('the cycle reaches flow from apollo, BEFORE sovereign (flow ≠ bypass; flow is the safer step)', autoIdx > 0 && bypassIdx > 0 && autoIdx < bypassIdx && apolloBlock.includes('canCycleToAuto'))
}

section('STARTUP-AUTO DESYNC fix — a session that BOOTS into auto arms the safety machinery')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  const mn = src('main.tsx')

  check(
    'site1: setAutoModeActive arming fires on startup mode==="flow"',
    /result\.mode === 'flow'\n?\s*\) \{\n?\s*autoModeStateModule\?\.setAutoModeActive\(true\)/.test(ps),
  )
  check(
    'site1: the arming module require in permissionSetup.ts is real (not null)',
    /autoModeStateModule =\s*\n?\s*\(require\('\.\/autoModeState\.js'\)/.test(ps),
  )

  check(
    'site2: findDangerousClassifierPermissions detection fires on startup permissionMode==="flow"',
    /permissionMode === 'flow'\n?\s*\) \{\n?\s*dangerousPermissions = findDangerousClassifierPermissions/.test(ps),
  )

  check(
    'site3: isAutoModeAvailable context flag is set unconditionally',
    /\{ isAutoModeAvailable: isAutoModeGateEnabled\(\) \}/.test(ps),
  )

  check(
    'site4: the main.tsx strip call fires on dangerous permissions',
    /dangerousPermissions\.length > 0/.test(mn),
  )

  check(
    'hazard-guard: main.tsx does NOT call setAutoModeActive at startup (module is null there)',
    !/setAutoModeActive\(true\)/.test(
      mn.slice(mn.indexOf('initializeToolPermissionContext'), mn.indexOf('const setupTrigger:')),
    ),
  )

}

section('dist ships the flow decision branches (floors, fast-paths, kill deny)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped branches')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('safety-floor headless-deny message ships', present('This action needs interactive approval, and this session cannot present a prompt'))
    check('org/MCP ask-ceiling reason ships', present('Your organization requires approval for this tool'))
    check('implement fast-path log ships', present('implement mode would allow this outright'))
    check('read-only set fast-path log ships', present('the read-only tool set'))
    check('no denial ledger ships', !present('actions were blocked this session') && !present('consecutive actions were blocked') && !present('denial limit reached'))
    check('capability kill-switch deny message ships', present('capability switched off by operator'))
    check('PowerShell auto-mode interactive-approval floor ships', present('PowerShell runs only with interactive approval'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PERMISSION / AUTO-MODE PROOFS PASS')
else console.log(`❌ ${failures} PERMISSION / AUTO-MODE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
