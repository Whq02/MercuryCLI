#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-bus-identity.ts
//  PROOF (bus Gap 1 + Gap 3): the fg Scribe takes a team-LEAD identity for team
//  'scribe' via engageScribeTeam — EMPTY teammates (no swarm UI), opt-in (default
//  OFF); + ensureScribeDaemon auto-start decision/wiring.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-bus-identity.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const MACRO_KEY = 'MACRO' as const
function setStamp(on: boolean): void {
  if (on) (globalThis as Record<string, unknown>)[MACRO_KEY] = { VERSION: '1.0.0' }
  else delete (globalThis as Record<string, unknown>)[MACRO_KEY]
}

console.log('============================================================')
console.log(' Scribe bus identity (Gap 1) — proof')
console.log('============================================================')

setStamp(true)
const gates = (await import('../../src/utils/scribe/scribeGates.js')) as typeof import('../../src/utils/scribe/scribeGates.js')
const team = (await import('../../src/utils/scribe/engageScribeTeam.js')) as typeof import('../../src/utils/scribe/engageScribeTeam.js')

type FakeState = { teamContext?: unknown }
function makeStore(init: Partial<FakeState> = {}) {
  let state: FakeState = { teamContext: undefined, ...init }
  return {
    getState: () => state,
    setState: (u: (p: FakeState) => FakeState) => { state = u(state) },
    peek: () => state,
  }
}

section('scribeBusLiveEnabled gate: ON by default for the fork, opt-out =0 (round-trip PROVEN live)')
delete process.env.MERCURY_SCRIBE_BUS_LIVE
check('default ON for the fork (no env) — the two-stream IS the feature', gates.scribeBusLiveEnabled() === true)
process.env.MERCURY_SCRIBE_BUS_LIVE = '0'
check('explicit =0 OFF (opt-out)', gates.scribeBusLiveEnabled() === false)
process.env.MERCURY_SCRIBE_BUS_LIVE = '1'
check('=1 ON (fork)', gates.scribeBusLiveEnabled() === true)

section('buildScribeTeamContext: lead of team scribe with EMPTY teammates (no swarm UI)')
const tc = team.buildScribeTeamContext() as Record<string, unknown>
check("teamName === 'scribe'", tc.teamName === 'scribe')
check("leadAgentId === 'scribe@scribe'", tc.leadAgentId === team.SCRIBE_LEAD_AGENT_ID)
check('isLeader === true', tc.isLeader === true)
check('teamFilePath is a non-empty string (getTeamFilePath loaded)', typeof tc.teamFilePath === 'string' && (tc.teamFilePath as string).length > 0)
check('teammates is EMPTY ({}) — the UI-safety invariant', Object.keys(tc.teammates as object).length === 0)

section('engage/disengage (ON): sets the lead context, restores prior on leave')
team.__resetScribeTeamStash()
const A = makeStore({})
team.engageScribeTeam(A as never)
const set = A.peek().teamContext as Record<string, unknown> | undefined
check('engage ⇒ teamContext set to scribe-lead', !!set && set.teamName === 'scribe' && set.leadAgentId === 'scribe@scribe')
check('engage ⇒ teammates still EMPTY on the live store', !!set && Object.keys(set.teammates as object).length === 0)
check('isScribeTeamEngaged() true after engage', team.isScribeTeamEngaged() === true)
team.engageScribeTeam(A as never) // idempotent
check('re-engage ⇒ idempotent (teamContext unchanged, still scribe)', (A.peek().teamContext as Record<string, unknown>).teamName === 'scribe')
team.disengageScribeTeam(A as never)
check('disengage ⇒ restores prior teamContext (undefined)', A.peek().teamContext === undefined)
check('isScribeTeamEngaged() false after disengage', team.isScribeTeamEngaged() === false)

section('engage (opt-OUT, =0): no-op ⇒ byte-identical')
team.__resetScribeTeamStash()
process.env.MERCURY_SCRIBE_BUS_LIVE = '0'
const B = makeStore({})
team.engageScribeTeam(B as never)
check('opt-out (=0) engage ⇒ teamContext untouched (undefined)', B.peek().teamContext === undefined)
check('opt-out ⇒ not engaged', team.isScribeTeamEngaged() === false)

section('Gap 3: ensureScribeDaemon — decideScribeDaemonAction (pure) + gated wiring')
const ensure = (await import('../../src/utils/scribe/ensureScribeDaemon.js')) as typeof import('../../src/utils/scribe/ensureScribeDaemon.js')
check("live daemon ⇒ 'noop' (idempotent, never double-spawn)", ensure.decideScribeDaemonAction('live') === 'noop')
check("off ⇒ 'spawn'", ensure.decideScribeDaemonAction('off') === 'spawn')
check("unavailable (stale/dead pid) ⇒ 'spawn'", ensure.decideScribeDaemonAction('unavailable') === 'spawn')
// OFF (no opt-in) ⇒ ensureScribeDaemon is a no-op: it must NOT spawn. Hard to test
// the spawn directly without side effects, but the gate is the first guard — assert
// it returns without throwing when the gate is off (no daemon spawned).
process.env.MERCURY_SCRIBE_BUS_LIVE = '0'
let threw = false
try { ensure.ensureScribeDaemon('/tmp/nonexistent-scribe-proj') } catch { threw = true }
check('opt-out (=0) ⇒ ensureScribeDaemon is an inert no-op (gated, no throw)', threw === false)
delete process.env.MERCURY_SCRIBE_BUS_LIVE

section('Gap 3 wiring (structural, src) — gated + idempotent + detached')
const es = src('utils', 'scribe', 'ensureScribeDaemon.ts')
check('ensureScribeDaemon gated on scribeBusLiveEnabled (first guard)', /if\s*\(!scribeBusLiveEnabled\(\)\)\s*return/.test(es))
check('probes via daemonSnapshot + spawns on a spawn-decision', /daemonSnapshot\(\)\.state/.test(es) && /decideScribeDaemonAction\(state\)\s*===\s*'spawn'\)/.test(es))
// idempotency is now PING-CONFIRMED: a 'live' snapshot (pid-only, can read live for a
// stale/reused/wedged daemon) is verified by a bounded control-socket ping before we
// trust it — only ping.ok is the true no-op; an unreachable daemon is cleared + respawned.
check('a live snapshot is ping-confirmed before noop (the Implementer-revive fix)', /daemonControlRpc\(\{ op: 'ping' \}/.test(es) && /if \(ping\.ok\) \{/.test(es) && /return \/\/ idempotent/.test(es))
check('ping-fail ⇒ clearDeadSupervisorRecords() then respawn', /clearDeadSupervisorRecords\(\)[\s\S]{0,160}spawnScribeDaemon/.test(es))
check('spawns via the shared owned-daemon seam (detached+unref+owner-pid+reaper live in spawnOwnedDaemon)', /spawnOwnedDaemon\(projectDir/.test(es))
const odSrc = src('daemon', 'ownedDaemon.ts')
// stdio: task #74 — stdout/stderr append to .claude/daemon/daemon.log (stdin stays
// 'ignore'); the old all-'ignore' shape swallowed every seat boot self-check.
// the spawn also HIDES the win32 console (the field flash class)
// — the pin now carries all three truths: detached · windowsHide · logged
// stdio, in order.
check('spawnOwnedDaemon itself spawns DETACHED + hidden + unref-d', /detached:\s*true[\s\S]{0,400}windowsHide:\s*true[\s\S]{0,300}stdio:\s*\['ignore', outFd, outFd\]/.test(odSrc) && /child\.unref\(\)/.test(odSrc))
const replSrc = src('screens', 'REPL.tsx')
const piSrc = src('components', 'PromptInput', 'PromptInput.tsx')
check('REPL launch effect calls ensureScribeDaemon(getProjectRoot())', /ensureScribeDaemon\(getProjectRoot\(\)\)/.test(replSrc))
check('the shared router-select helper calls ensureScribeDaemon(getProjectRoot())', /ensureScribeDaemon\(getProjectRoot\(\)\)/.test(src('utils', 'scribe', 'scribeRouterSelect.ts')))
check('PromptInput delegates router selection to the shared helper (value + setAppState + the named store)', /handleScribeRouterSelect\(value, \{ setAppState, store: appStateStore \}\)/.test(piSrc))

setStamp(false)
console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL BUS-IDENTITY PROOFS PASS')
else console.log(`❌ ${failures} BUS-IDENTITY PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
