#!/usr/bin/env bun
// ============================================================================
//  scripts/model-floor/prove-floor-coverage.ts
//  PROOF: the floor is WIRED at every resolution seam — the
//  exported getAgentModel IS the floored wrapper (no raw leak), the daemon
//  spawn floors spec.model, the teammate resolver floors its return (the path
//  that bypasses getAgentModel entirely), and the floor survives into the
//  built binary (host-vs-binary lesson: grep dist with STRING literals).
//  Structural by design — spawnMultiAgent.ts is not bun-loadable.
//  Run:  ~/.bun/bin/bun run scripts/model-floor/prove-floor-coverage.ts
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Never-Haiku floor — coverage (wiring) proof')
console.log('============================================================')

section('agent.ts — exported getAgentModel IS the floored wrapper, raw resolver private')
const agent = src('utils', 'model', 'agent.ts')
check('raw resolver is module-private (not exported)', /function resolveAgentModelRaw\(/.test(agent) && !/export function resolveAgentModelRaw/.test(agent))
// Seam shape since the wave-2 floor-note refactor: getAgentModel delegates to
// getAgentModelWithFloorNote (the reporting variant AgentTool threads into its
// spawn result), which is the ONE place that wraps floor(raw(...)).
check('exported getAgentModel delegates to the WithFloorNote chokepoint', /export function getAgentModel[\s\S]{0,400}getAgentModelWithFloorNote\(agentModel, parentModel, toolSpecifiedModel, permissionMode\)\.model/.test(agent))
check('the chokepoint wraps via enforceSubagentModelFloor', /export function getAgentModelWithFloorNote[\s\S]{0,600}enforceSubagentModelFloor\(\s*raw,/.test(agent) && /const raw = resolveAgentModelRaw\(/.test(agent))
check('imports the floor', /from '\.\/modelFloor\.js'/.test(agent))
check('no second export of a bare resolver', (agent.match(/export function getAgentModel\(/g) ?? []).length === 1)

section('headlessRun.ts — daemon spawn seam floors every AUTONOMOUS spec.model')
const hr = src('daemon', 'headlessRun.ts')
check('buildStreamJsonInvocation floors every autonomous role and passes the operator’s own concourse session through',
  /const model =\s*\n\s*spec\.role === 'MERCURY_CONCOURSE_WORKER'\s*\n\s*\? spec\.model\s*\n\s*: enforceSubagentModelFloor\(spec\.model,\s*`daemon:\$\{spec\.agentName\}`\)/.test(hr))
// The keyless arm passes no --model at all (the runner's own resolution
// follows the next sign-in); the keyed arm names the floored model.
check('argv uses the floored model (not spec.model)', /\['--model', model\]/.test(hr))
check('ANTHROPIC_MODEL uses the floored model', /ANTHROPIC_MODEL:\s*model,/.test(hr))
check('imports the floor', /from '\.\.\/utils\/model\/modelFloor\.js'/.test(hr))

section('spawnMultiAgent.ts — teammate resolver floors its return (bypasses getAgentModel)')
const sma = src('tools', 'shared', 'spawnMultiAgent.ts')
check('resolveTeammateModel returns via enforceSubagentModelFloor', /function resolveTeammateModel[\s\S]{0,700}return enforceSubagentModelFloor\(resolved,\s*'spawnTeammate'\)/.test(sma))
check('imports the floor', /from '\.\.\/\.\.\/utils\/model\/modelFloor\.js'/.test(sma))

section('residual seams floored (refute pass #3) — daemon worker loop + backends + hook-agent')
const model = src('utils', 'model', 'model.ts')
check('getMainLoopModel floors a DEFAULTED resolution when the worker-parent pid is set (an explicit setting is the operator’s word)', /fromDefault && flagEnv\('MERCURY_WORKER_PARENT_PID'\)\)[\s\S]{0,120}enforceSubagentModelFloor\(resolved, 'daemon:worker-loop'\)/.test(model))
const headless = src('daemon', 'headlessRun.ts')
check('runTaskHeadless stamps the worker-parent pid in both spellings (arms the loop floor + self-exit)', /stampFlagOnEnv\(oneShotEnv, WORKER_PARENT_PID_ENV, String\(process\.pid\)\)/.test(headless))
check('hook-agent model is floored (an agent hook runs a real tool-using subagent)', /enforceSubagentModelFloor\(hook\.model \?\? sessionLightModel\(\), 'hook-agent'\)/.test(src('utils', 'hooks', 'execAgentHook.ts')))
check('InProcessBackend floors config.model', /enforceSubagentModelFloor\(config\.model, 'inProcessTeammateSpawn'\)/.test(src('utils', 'swarm', 'backends', 'InProcessBackend.ts')))
check('PaneBackendExecutor floors config.model', /enforceSubagentModelFloor\(config\.model, 'paneTeammateSpawn'\)/.test(src('utils', 'swarm', 'backends', 'PaneBackendExecutor.ts')))

section('modelFloor.ts — invariant shape (no kill-switch, stamp-gated, fixed fallback)')
const floor = src('utils', 'model', 'modelFloor.ts')
check('the floor applies unconditionally ', !/isHermesForkBuild/.test(floor) && /export function enforceSubagentModelFloor/.test(floor))
check('NO env read (no kill-switch — a fork invariant, not a flag)', !/process\.env\./.test(floor))
check("fallback pinned to 'claude-sonnet-5'", /NEVER_HAIKU_FALLBACK = 'claude-sonnet-5'/.test(floor))

section('dist binary — floor survives the bundle (STRING-literal grep)')
const distPath = join(import.meta.dir, '..', '..', 'dist', 'mercury.mjs')
if (existsSync(distPath)) {
  const dist = readFileSync(distPath, 'utf-8')
  check("dist contains the floor log marker '[modelFloor]'", dist.includes('[modelFloor]'))
  check("dist contains 'never-Haiku floor fired'", dist.includes('never-Haiku floor fired'))
} else {
  // Building is the gate's job elsewhere; absence of dist is not a floor bug.
  console.log('  [SKIP] dist/mercury.mjs not built — run `bun run build.ts` for the binary half')
}

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL PASS')
