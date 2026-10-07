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
console.log(' Permission ladder / flow — surface proof')
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

section('isReadOnlyAllowlistedTool name gating (readOnlyAllowlist.ts)')
{
  const cd = src('utils', 'permissions', 'readOnlyAllowlist.ts')
  const has = (needle: string) => cd.includes(needle)
  check('exists + gates read-only tool names on the allowlist SET', has('export function isReadOnlyAllowlistedTool') && has('READ_ONLY_ALLOWLISTED_TOOLS.has(toolName)'))
  const safeSetStart = cd.indexOf('const READ_ONLY_ALLOWLISTED_TOOLS: ReadonlySet<string> = new Set([')
  const safeSet = safeSetStart === -1 ? '' : cd.slice(safeSetStart, cd.indexOf('])', safeSetStart))
  check('the safe set carries the read-only tools (positive control)', safeSet.includes('FILE_READ_TOOL_NAME,') && safeSet.includes('GREP_TOOL_NAME,') && safeSet.includes('GLOB_TOOL_NAME,'))
  check('write/edit tools are NOT on the safe set (absence, file-wide)', safeSet.length > 0 && !has('FILE_WRITE_TOOL_NAME,') && !has('FILE_EDIT_TOOL_NAME,'))
}

section('Flow availability is the settings lock alone')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  check('settings close availability, and nothing else does', ps.includes('return !isAutoModeDisabledBySettings()') && !ps.includes('CircuitBroken') && !ps.includes('getEngineModel'))
  check('the settings restriction has its reason and its words', ps.includes("if (isAutoModeDisabledBySettings()) return 'settings'") && ps.includes("return 'Flow is closed by your settings.'"))
  const gnpm = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('the carousel gates auto SOLELY on canCycleToAuto (unconditional)', gnpm.includes('canCycleToAuto(toolPermissionContext)'))
  const apolloBlock = gnpm.slice(gnpm.indexOf("case 'apollo':"), gnpm.indexOf("case 'flow':"))
  const autoIdx = apolloBlock.indexOf("return 'flow'")
  const bypassIdx = apolloBlock.indexOf("return 'sovereign'")
  check('the cycle reaches flow from apollo, BEFORE sovereign (flow ≠ bypass; flow is the safer step)', autoIdx > 0 && bypassIdx > 0 && autoIdx < bypassIdx && apolloBlock.includes('canCycleToAuto'))
}

section('a session that BOOTS into flow sets its dangerous allow rules aside, as a runtime entry does')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  const mn = src('main.tsx')
  check(
    'dangerous-rule detection fires on startup permissionMode==="flow"',
    /permissionMode === 'flow'\n?\s*\) \{\n?\s*dangerousPermissions = findDangerousPermissions/.test(ps),
  )
  check(
    'the isAutoModeAvailable context flag is set from the gate at startup',
    /\{ isAutoModeAvailable: isAutoModeGateEnabled\(\) \}/.test(ps),
  )
  check(
    'the main.tsx strip call fires on dangerous permissions',
    /dangerousPermissions\.length > 0/.test(mn),
  )
  check('no in-process flow state is armed anywhere (the mode on the context is the whole state)', !ps.includes('setAutoModeActive') && !mn.includes('setAutoModeActive'))
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
