#!/usr/bin/env bun
// ============================================================================
//  scripts/scribe/prove-daemon-reap.ts
//  PROOF: the auto-started scribe daemon never lingers after the CLI closes
//  (the operator bug: "it's not shutting down"). Two layers:
//   (1) ownerWatch pure logic — parse owner pid, liveness probe, reap decision;
//   (2) wiring — ensureScribeDaemon stamps the owner pid + catches SIGHUP, and
//       daemon/main.ts arms the owner-watch + clears it on shutdown.
//  The "exit does NOT fire on SIGHUP" fact this fix rests on is verified live in
//  the run-all harness; here we assert the logic + the wiring are in place.
//  Run:  ~/.bun/bin/bun run scripts/scribe/prove-daemon-reap.ts
// ============================================================================
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
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

const ow = (await import('../../src/daemon/ownerWatch.js')) as typeof import('../../src/daemon/ownerWatch.js')

console.log('============================================================')
console.log(' Scribe daemon owner-orphan self-reap — proof')
console.log('============================================================')

section('parseOwnerPid')
check('env set ⇒ the pid', ow.parseOwnerPid({ [ow.OWNER_PID_ENV]: '4242' } as NodeJS.ProcessEnv) === 4242)
check('env unset ⇒ null (explicit `mercury daemon` ⇒ persists)', ow.parseOwnerPid({} as NodeJS.ProcessEnv) === null)
check('non-numeric ⇒ null', ow.parseOwnerPid({ [ow.OWNER_PID_ENV]: 'nope' } as NodeJS.ProcessEnv) === null)
check('zero/negative ⇒ null', ow.parseOwnerPid({ [ow.OWNER_PID_ENV]: '0' } as NodeJS.ProcessEnv) === null && ow.parseOwnerPid({ [ow.OWNER_PID_ENV]: '-3' } as NodeJS.ProcessEnv) === null)

section('isProcessAlive (signal-0 probe)')
check('our own pid ⇒ alive', ow.isProcessAlive(process.pid) === true)
// A pid that is essentially never live (max+something). ESRCH ⇒ not alive.
check('a dead/absent pid ⇒ not alive', ow.isProcessAlive(2 ** 31 - 1) === false)

section('decideOrphanShutdown (pure reap gate)')
const G = ow.OWNER_WATCH_GRACE_CHECKS
check('persist=true ⇒ never reap', ow.decideOrphanShutdown({ ownerPid: 10, ownerAlive: false, deadStreak: 99, graceChecks: G, persist: true }) === false)
check('ownerPid=null (explicit daemon) ⇒ never reap', ow.decideOrphanShutdown({ ownerPid: null, ownerAlive: false, deadStreak: 99, graceChecks: G, persist: false }) === false)
check('owner alive ⇒ never reap', ow.decideOrphanShutdown({ ownerPid: 10, ownerAlive: true, deadStreak: 0, graceChecks: G, persist: false }) === false)
check('owner gone but below grace ⇒ hold', ow.decideOrphanShutdown({ ownerPid: 10, ownerAlive: false, deadStreak: G - 1, graceChecks: G, persist: false }) === false)
check('owner gone for >= grace ⇒ REAP', ow.decideOrphanShutdown({ ownerPid: 10, ownerAlive: false, deadStreak: G, graceChecks: G, persist: false }) === true)

section('wiring — the shared owned-daemon seam (spawnOwnedDaemon)')
const od = src('daemon', 'ownedDaemon.ts')
check('stamps the owner pid in the spawn env — BOTH spellings (mixed-version window)', /flagPair\(OWNER_PID_ENV,\s*String\(process\.pid\)\)/.test(od))
check('catches SIGHUP (terminal close) to reap (exit alone does NOT fire on SIGHUP)', /process\.once\('SIGHUP'/.test(od))
check('keeps the graceful-exit reaper', /process\.once\('exit'/.test(od))
check('honors MERCURY_SCRIBE_DAEMON_PERSIST opt-out', /shouldReapAutoStartedDaemon/.test(od))
check('spawns detached + unref (auto-start, no terminal hold)', /detached: true/.test(od) && /child\.unref\(\)/.test(od))

section('wiring — BOTH auto-starts route through the seam (no orphan path)')
const esd = src('utils', 'scribe', 'ensureScribeDaemon.ts')
check('ensureScribeDaemon spawns via spawnOwnedDaemon (route/fable extraEnv)', /spawnOwnedDaemon\(projectDir, \{/.test(esd) && /label: 'scribe'/.test(esd))
// a live-and-serving FOREIGN daemon (booted without the scribe-
// engage stamp) can never host the Implementer (registration is boot-only), so
// the live branch verifies hosting via the `has` RPC and surfaces the wedge as
// engage's 'already-live' honesty. `present` covers settled entries, so a
// crashed-but-supervised Implementer never false-alarms.
check("live branch verifies Implementer hosting (has RPC, 'implementer')", /op: 'has', short: 'implementer'/.test(esd))
check('an unhostable daemon surfaces ONE warning receipt with remediation', /mintImmediateReceipt\(\s*\n?\s*'▲ Scribe engaged, but the running daemon/.test(esd) && /mercury daemon stop/.test(esd) && /'warning'/.test(esd))
check('a transient has-RPC failure never alarms (no receipt on a guess)', /catch \{\s*\n\s*\/\* transient RPC failure — never alarm on a guess \*\//.test(esd))

section('wiring — daemon/main.ts (daemon side)')
const main = src('daemon', 'main.ts')
check('arms the owner-watch from parseOwnerPid()', /parseOwnerPid\(\)/.test(main))
check('only when an owner pid is present + not persisting', /ownerPid !== null && !persist/.test(main))
// The orphan reap parks every active session FIRST, then rides
// the one shutdown path — parkAllThenShutdown('owner-orphaned').
check('reaps via parkAllThenShutdown (sessions parked, then the one shutdown path)', /parkAllThenShutdown\('owner-orphaned'\)/.test(main))
check('owner-watch interval is unref\'d (never the keep-alive anchor)', /ownerWatch\.unref\?\.\(\)/.test(main))
check('owner-watch cleared on shutdown (no dangling timer)', /if \(ownerWatch\)\s*\{[\s\S]{0,80}clearInterval\(ownerWatch\)/.test(main))

section('worker→daemon parent-watch (#44 — a worker never outlives its supervisor)')
const wpw = (await import('../../src/daemon/workerParentWatch.js')) as typeof import('../../src/daemon/workerParentWatch.js')
check('parseWorkerParentPid: no env ⇒ null (not a spawned worker ⇒ never arms)', wpw.parseWorkerParentPid({}) === null)
check('parseWorkerParentPid: valid ⇒ pid', wpw.parseWorkerParentPid({ MERCURY_WORKER_PARENT_PID: '4321' }) === 4321)
check('parseWorkerParentPid: junk ⇒ null', wpw.parseWorkerParentPid({ MERCURY_WORKER_PARENT_PID: 'x' }) === null)
const SAVE_P = process.env.MERCURY_WORKER_PARENT_PID
delete process.env.MERCURY_WORKER_PARENT_PID
wpw.__resetWorkerParentWatchForTests()
check('armWorkerParentWatch: no env ⇒ no-op (byte-identical for the foreground)', wpw.armWorkerParentWatch() === false)
process.env.MERCURY_WORKER_PARENT_PID = '424242'
wpw.__resetWorkerParentWatchForTests()
let exitCode = -1
check('armWorkerParentWatch: with env ⇒ arms', wpw.armWorkerParentWatch({ exit: c => { exitCode = c }, alive: () => true }) === true)
wpw.__resetWorkerParentWatchForTests()
check('armWorkerParentWatch: idempotent (a 2nd arm is a no-op until reset)', (wpw.armWorkerParentWatch({ exit: () => {}, alive: () => true }), wpw.armWorkerParentWatch({ exit: () => {}, alive: () => true }) === false))
SAVE_P === undefined ? delete process.env.MERCURY_WORKER_PARENT_PID : (process.env.MERCURY_WORKER_PARENT_PID = SAVE_P)
check('reuses ownerWatch decideOrphanShutdown: dead parent + grace ⇒ exit', ow.decideOrphanShutdown({ ownerPid: 424242, ownerAlive: false, deadStreak: 2, graceChecks: 2, persist: false }) === true)
check('live parent ⇒ never exit', ow.decideOrphanShutdown({ ownerPid: 424242, ownerAlive: true, deadStreak: 9, graceChecks: 2, persist: false }) === false)
const hr = src('daemon', 'headlessRun.ts')
check('spawnStreamJsonChild stamps the worker parent pid (both spellings)', /stampFlagOnEnv\(env, WORKER_PARENT_PID_ENV, String\(process\.pid\)\)/.test(hr))
const qe = src('QueryEngine.ts')
check('worker arms the parent-watch at role startup (self-gating)', /armWorkerParentWatch\(\)/.test(qe))

section('R5b — owner IDENTITY (pid + start token) closes the PID-reuse reap gap')
// getProcessStartToken: our own LIVE pid ⇒ a real lstart token; a (very likely) dead
// high pid ⇒ '' (ps ran, no such process). Both are real `ps` calls (loadable).
const selfTok = ow.getProcessStartToken(process.pid)
check('getProcessStartToken(self) ⇒ a non-empty lstart token', typeof selfTok === 'string' && selfTok.length > 0)
check('getProcessStartToken(dead high pid) ⇒ "" (gone)', ow.getProcessStartToken(2147480000) === '')
// ownerIdentityMatches decision table — the PID-reuse fix:
check('same token ⇒ owner present', ow.ownerIdentityMatches('Wed Jun 18 15:52:20 2026', 'Wed Jun 18 15:52:20 2026') === true)
check('DIFFERENT token (pid reused by another process) ⇒ NOT the owner ⇒ reap proceeds', ow.ownerIdentityMatches('Thu Jun 19 09:00:00 2026', 'Wed Jun 18 15:52:20 2026') === false)
check('current "" (pid gone per ps) ⇒ not present', ow.ownerIdentityMatches('', 'Wed Jun 18 15:52:20 2026') === false)
check('no usable baseline (ps unavailable at arm) ⇒ pid-liveness fallback (true)', ow.ownerIdentityMatches('x', null) === true && ow.ownerIdentityMatches('x', '') === true)
check('current null (probe glitch on a live pid) ⇒ fail-safe true (never reap on ambiguity)', ow.ownerIdentityMatches(null, 'Wed Jun 18 15:52:20 2026') === true)

section('R5b/R5c — main.ts daemon-side wiring (structural; main.ts is not bun-loadable)')
const mainR5 = src('daemon', 'main.ts')
check('R5b: the watch captures the owner start token ONCE at arm', /const ownerStartToken = getProcessStartToken\(ownerPid\)/.test(mainR5))
// The per-probe token query is async (the win32 sync spawn
// blocked the daemon loop); the R5b requirement is unchanged — live pid AND
// matching identity, every probe.
check('R5b: each probe requires a live pid AND a matching identity', /isProcessAlive\(ownerPid\)\s*&&\s*ownerIdentityMatches\(await getProcessStartTokenAsync\(ownerPid\), ownerStartToken\)/.test(mainR5))
check('R5b: the async probe is single-flight (a slow PowerShell can never stack probes)', /ownerProbeInflight/.test(mainR5))
check('R5c: uncaughtException → crashShutdown', /process\.on\('uncaughtException', err => crashShutdown\('uncaughtException'/.test(mainR5))
check('R5c: unhandledRejection → crashShutdown', /process\.on\('unhandledRejection', reason => crashShutdown\('unhandledRejection'/.test(mainR5))
// Window 500/600 → 1400/1500: the unified crash-archive block
// (persistCrashReport — forensics, never a dependency of the reap) landed
// between the guard's declaration and its teardown lines; the adjacency
// requirement itself is unchanged.
check('R5c: the crash guard reuses the graceful shutdown (reaps workers + socket + state)', /crashShutdown[\s\S]{0,1400}shutdown\(label\)/.test(mainR5))
check('R5c: a failsafe force-exits a wedged crashed daemon (non-zero)', /crashShutdown[\s\S]{0,1500}setTimeout\(\(\) => process\.exit\(1\), 2000\)/.test(mainR5))

section('win32 start-token verdict — a broken probe is never a dead owner (TASK-014 w5-f02-01)')
// The pure mapper both win32 probe forms ride. Vocabulary: token · '' gone ·
// null unknown. Real PowerShell/CIM behaviour is NEEDS-REAL-BOX; the shapes
// below are the ones the field box recorded.
{
  const v = ow.win32StartTokenVerdict
  check('could not run ⇒ unknown (null)', v({ ran: false, exitCode: null, stdout: '', stderr: '' }) === null)
  check('non-zero exit ⇒ unknown, never gone', v({ ran: true, exitCode: 1, stdout: '', stderr: '' }) === null)
  check('exit 0 + empty stdout + stderr text (non-terminating CIM error) ⇒ unknown — THE broken-probe shape', v({ ran: true, exitCode: 0, stdout: '', stderr: 'Get-CimInstance : Access denied' }) === null)
  check('exit 0 + a token ⇒ the token, trimmed', v({ ran: true, exitCode: 0, stdout: '20260827093012.123456+060\r\n', stderr: '' }) === '20260827093012.123456+060')
  check('exit 0 + a token with stderr noise still returns the token', v({ ran: true, exitCode: 0, stdout: 'tok', stderr: 'warning' }) === 'tok')
  check('exit 0 + empty stdout + empty stderr ⇒ gone (the ONLY gone)', v({ ran: true, exitCode: 0, stdout: '', stderr: '' }) === '')
  check('null streams are read as empty', v({ ran: true, exitCode: 0, stdout: null, stderr: undefined }) === '')
  const owSrc = src('daemon', 'ownerWatch.ts')
  check('the sync win32 form rides the mapper', /return win32StartTokenVerdict\(\{ ran: !r\.error, exitCode: r\.status, stdout: r\.stdout, stderr: r\.stderr \}\)/.test(owSrc))
  check('the async win32 form rides the mapper with the exit code from execFile', /resolve\(win32StartTokenVerdict\(\{ ran: true, exitCode, stdout, stderr \}\)\)/.test(owSrc))
  check('no win32 arm reads empty stdout as gone on its own any more', !/s\.length > 0 \? s : '' \/\/ empty ⇒ pid not found ⇒ gone/.test(owSrc))
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-REAP PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-REAP PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
