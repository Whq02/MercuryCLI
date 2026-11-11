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

section('the Flow band (decision/wrapper.ts → flowPolicy.ts): the floors it keeps, the five, then allow')
{
  const wrapper = src('utils', 'permissions', 'decision', 'wrapper.ts')
  const policy = src('utils', 'permissions', 'flowPolicy.ts')
  const law = src('utils', 'permissions', 'flowLaw.ts')
  check('the wrapper hands every Flow ask to decideUnderFlow and settles it in one of three stages', wrapper.includes('decideUnderFlow(tool, input, engineDecision, appState.toolPermissionContext)') && wrapper.includes("decide('flowAllow', verdict.decision)") && wrapper.includes("verdict.stage === 'flowLaw'") && wrapper.includes("verdict.stage === 'flowFloors'"))
  check('the kept floors: an ask rule, an operator-only safety check, a hook, a tool that asks the human, the MCP ask ceiling', policy.includes("return 'ask-rule'") && policy.includes("if (reasonCarriesOperatorSafety(reason)) return 'safety'") && policy.includes("if (reason.type === 'safetyCheck') return reason.operatorOnly") && policy.includes("reason?.type === 'hook'") && policy.includes('tool.requiresUserInteraction?.()') && policy.includes("tool.mcpInfo?.effectiveMaxPermission === 'ask'"))
  check('the five are read from one table (FLOW_LAW) and the ask sentence has one shape', law.includes('export const FLOW_LAW = {') && law.includes('return `Flow asks before ${ask.subject}: ${ask.why}.`'))
  check('nothing else asks: the shortcuts, the PowerShell guard, the install floor and the read-only tool set are gone from the wrapper', !wrapper.includes('implementFastPath') && !wrapper.includes('allowlistFastPath') && !wrapper.includes('powershellGuard') && !wrapper.includes('flowPushOrInstall') && !wrapper.includes('readOnlyAllowlist') && !wrapper.includes('flowRequiresFreshApproval'))
  check('a plain yes in Flow saves nothing on its own (the auto-remembered rule is gone)', !policy.includes('flowUserAllowUpdates') && !src('hooks', 'toolPermission', 'PermissionContext.ts').includes('flowUserAllowUpdates') && !src('cli', 'headless', 'runnerAsks.ts').includes('flowUserAllowUpdates'))
  const engine = src('utils', 'permissions', 'decision', 'engine.ts')
  check('kill-switch is step 0 of the ladder (per-call agentType)', engine.includes('ports.isToolKilled(tool, context.agentType)'))
  const trace = src('utils', 'permissions', 'decision', 'trace.ts')
  check('the trace names the three Flow stages in order, between the dontAsk conversion and the headless band', /'dontAskConversion',\n  'flowFloors',\n  'flowLaw',\n  'flowAllow',\n  'headlessHooks',\n  'headlessAutoDeny',/.test(trace))
}

section('Flow availability is the settings lock alone')
{
  const ps = src('utils', 'permissions', 'permissionSetup.ts')
  check('settings close availability, and nothing else does', ps.includes('return !isFlowDisabledBySettings()') && !ps.includes('CircuitBroken') && !ps.includes('getEngineModel'))
  check('the settings restriction has its reason and its words', ps.includes("if (isFlowDisabledBySettings()) return 'settings'") && ps.includes("return 'Flow is closed by your settings.'"))
  const gnpm = src('utils', 'permissions', 'getNextPermissionMode.ts')
  check('the carousel gates flow SOLELY on canCycleToFlow (unconditional)', gnpm.includes('canCycleToFlow(toolPermissionContext)'))
  const apolloBlock = gnpm.slice(gnpm.indexOf("case 'apollo':"), gnpm.indexOf("case 'flow':"))
  const flowIdx = apolloBlock.indexOf("return 'flow'")
  const bypassIdx = apolloBlock.indexOf("return 'sovereign'")
  check('the cycle reaches flow from apollo, BEFORE sovereign (flow ≠ bypass; flow is the safer step)', flowIdx > 0 && bypassIdx > 0 && flowIdx < bypassIdx && apolloBlock.includes('canCycleToFlow'))
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
    'the isFlowAvailable context flag is set from the gate at startup',
    /\{ isFlowAvailable: isFlowGateEnabled\(\) \}/.test(ps),
  )
  check(
    'the main.tsx strip call fires on dangerous permissions',
    /dangerousPermissions\.length > 0/.test(mn),
  )
  check('no in-process flow state is armed anywhere (the mode on the context is the whole state)', !ps.includes('setAutoModeActive') && !mn.includes('setAutoModeActive'))
}

section('the words the model is briefed with name the five')
{
  const posture = src('utils', 'cockpit', 'runtimePosture.ts')
  check('the posture line under flow names the five and tells the model everything else runs', posture.includes('and under flow only the five:') && posture.includes('everything else runs without a question, so run it'))
  const gloss = src('utils', 'settings', 'validationTips.ts')
  check('the mode gloss says what asks and that everything else runs', /flow: 'everything runs except sudo, git push and history rewrites, publishing and deploying, and writes outside the project, which ask'/.test(gloss))
}

section('dist ships the flow decision branches (the five, the floors, kill deny)')
{
  const dist = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
  if (!existsSync(dist)) {
    console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` to grep-verify the shipped branches')
  } else {
    const present = (needle: string): boolean =>
      execSync(`grep -F -c ${JSON.stringify(needle)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
    check('the ask sentence shape ships', present('Flow asks before '))
    check('the five\'s reasons ship', present('it runs with elevated rights') && present('it publishes history') && present('it publishes a package') && present(', outside the project'))
    check('the Flow allow log ships', present('none of the five'))
    check('no denial ledger ships', !present('actions were blocked this session') && !present('consecutive actions were blocked') && !present('denial limit reached'))
    check('capability kill-switch deny message ships', present('capability switched off by operator'))
    check('the old shortcuts do not ship', !present('implement mode would allow this outright') && !present('PowerShell runs only with interactive approval'))
  }
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL PERMISSION / FLOW PROOFS PASS')
else console.log(`❌ ${failures} PERMISSION / FLOW PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
