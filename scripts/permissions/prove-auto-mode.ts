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

section('denialTracking (LIVE) — limits + the fall-back-to-prompting threshold')
{
  const dt = await import('../../src/utils/permissions/denialTracking.js')
  const {
    DENIAL_LIMITS,
    createDenialTrackingState,
    recordDenial,
    recordSuccess,
    shouldFallbackToPrompting,
  } = dt

  check('limits are the canonical 3 consecutive / 20 total', DENIAL_LIMITS.maxConsecutive === 3 && DENIAL_LIMITS.maxTotal === 20)

  let s = createDenialTrackingState()
  check('fresh state does NOT fall back', !shouldFallbackToPrompting(s))

  s = recordDenial(recordDenial(s))
  check('2 consecutive denials: still classifying (no fallback)', !shouldFallbackToPrompting(s))
  s = recordDenial(s)
  check('3 consecutive denials: FALL BACK to prompting (consecutive floor)', shouldFallbackToPrompting(s))
  check('counters track both consecutive + total', s.consecutiveDenials === 3 && s.totalDenials === 3)

  const after = recordSuccess(s)
  check('recordSuccess resets the consecutive streak', after.consecutiveDenials === 0)
  check('recordSuccess preserves the total (it is a session ceiling)', after.totalDenials === 3)
  check('after a success, no longer falling back on the consecutive floor', !shouldFallbackToPrompting(after))
  check('recordSuccess is a no-op (same ref) when consecutive is already 0', recordSuccess(after) === after)

  let t = createDenialTrackingState()
  for (let i = 0; i < 19; i++) t = recordSuccess(recordDenial(t))
  check('19 total denials, streak broken each time: not yet falling back', !shouldFallbackToPrompting(t) && t.totalDenials === 19)
  t = recordDenial(t)
  check('20 total denials: FALL BACK (total floor, independent of streak)', shouldFallbackToPrompting(t) && t.totalDenials === 20)
}

section('the FOUR auto-mode safety floors (decision/wrapper.ts) — force a human ask BEFORE the classifier')
{
  const perms = src('utils', 'permissions', 'decision', 'wrapper.ts')
  const has = (needle: string) => perms.includes(needle)
  check('floor: ask-rule reason → reasonCarriesAskRule', has('function reasonCarriesAskRule') && has('reasonCarriesAskRule(engineDecision.decisionReason)'))
  check("floor: org/MCP ask-ceiling (effectiveMaxPermission === 'ask')", has("tool.mcpInfo?.effectiveMaxPermission === 'ask'"))
  check('floor: plan-mode → reasonIsPlanFloor', has('function reasonIsPlanFloor') && has('reasonIsPlanFloor(engineDecision.decisionReason)'))
  check('floor: Workflow usage-consent → workflowRequiresConsent', has('function workflowRequiresConsent') && has('workflowRequiresConsent(tool.name)'))
  check(
    'the four floors converge on ONE guard before the classifier',
    has("floorTags.push('ask-rule')") &&
      has("floorTags.push('org-ceiling')") &&
      has("floorTags.push('plan-floor')") &&
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
  check('exists + gates safe-tool names on the allowlist SET', has('export function isAutoModeAllowlistedTool') && has('SAFE_YOLO_ALLOWLISTED_TOOLS.has(toolName)'))
  check('no chrome-name allowlist residue (removed feature cannot re-grant)', !has('CHROME_READONLY_TOOLS') && !has('claude-in-chrome') && !has('ALLOWLISTED_COMPUTER_ACTIONS'))
  check('write/edit tools are NOT on the safe set (comment + absence)', has('Does NOT include write/edit tools') && !has('FILE_WRITE_TOOL_NAME,') && !has('FILE_EDIT_TOOL_NAME,'))
}

section('Flow availability uses settings and runtime safety state')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  check('availability does not import an external configuration table', !ps.includes('services/analytics/featureGates'))
  check('the runtime circuit breaker closes availability', ps.includes('if (isAutoModeCircuitBroken()) return false'))
  check('settings close availability', ps.includes('if (isAutoModeDisabledBySettings()) return false'))
  check('verification updates the circuit breaker from settings', ps.includes('const circuitBroken = disabledBySettings') && ps.includes('autoModeStateModule?.setAutoModeCircuitBroken(circuitBroken)'))
  check('the runtime restriction has an explanatory reason', ps.includes("if (isAutoModeCircuitBroken()) return 'circuit-breaker'"))
  check('explicit availability still requires a supported model', ps.includes('const explicitAvailable = !disabledBySettings && modelSupported'))
  const gnpm = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('the carousel gates auto SOLELY on canCycleToAuto (unconditional)', gnpm.includes('canCycleToAuto(toolPermissionContext)'))
  const planBlock = gnpm.slice(gnpm.indexOf("case 'strategy':"), gnpm.indexOf("case 'flow':"))
  const autoIdx = planBlock.indexOf("return 'flow'")
  const bypassIdx = planBlock.indexOf("return 'sovereign'")
  check('the cycle reaches flow from strategy, BEFORE sovereign (flow ≠ bypass; flow is the safer step)', autoIdx > 0 && bypassIdx > 0 && autoIdx < bypassIdx && planBlock.includes('canCycleToAuto'))
}

section('STARTUP-AUTO DESYNC fix — a fork that BOOTS into auto arms the safety machinery')
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

section('dist ships the auto-mode decision branches (floors, fast-paths, denial fallback, kill deny)')
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
    check('safe-allowlist fast-path log ships', present('always-safe tool set membership'))
    check('denial-limit total fallback warning ships', present('actions were blocked this session'))
    check('denial-limit consecutive fallback warning ships', present('consecutive actions were blocked'))
    check('headless denial-limit hard abort ships', present('denial limit reached with no prompt available'))
    check('capability kill-switch deny message ships', present('capability switched off by operator'))
    check('PowerShell auto-mode interactive-approval floor ships', present('PowerShell runs only with interactive approval'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PERMISSION / AUTO-MODE PROOFS PASS')
else console.log(`❌ ${failures} PERMISSION / AUTO-MODE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
