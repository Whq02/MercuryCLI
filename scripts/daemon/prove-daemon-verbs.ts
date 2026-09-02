#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-daemon-verbs.ts — the `mercury daemon <verb>` grammar.
//
//  TASK-014 W5 (w5-f01-02 / f02-04 / f05-04, S1): every unrecognised word
//  fell through to the supervisor with the word as its scheduling directory
//  — `daemon --help` started the scheduler in the operator's console, `daemon
//  start` aimed it at a phantom dir. And w5-f01-01: `daemon stop --any`, the
//  remedy `daemon status` prints for a stale record, could not clear it.
//    (1) the pure grammar — bare · run [dir] · a directory positional (absolute,
//        separator-bearing, or an existing directory) · status · stop [--keep]
//        · restart · help spellings · every other word REFUSED
//    (2) daemonMain rides the grammar: help prints the usage, unknown sets a
//        non-zero exit and never reaches daemonRun
//    (3) the product's own owned-daemon spawn says `daemon run <dir>`
//    (4) stop on ENOCONN sweeps a record whose pid is GONE (and only then);
//        the status headline stops saying "running" for a record that does
//        not answer; win32 names its pipe
//  Hermetic — no daemon is started. Win32 pid-liveness is NEEDS-REAL-BOX.
//  Run:  ~/.bun/bin/bun run scripts/daemon/prove-daemon-verbs.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_USAGE, looksLikeDirectoryArg, parseDaemonVerb, START_TOKEN_SKEW_MS, staleStopVerdict, startTokenEpochMs, supervisorRecordIdentity } from '../../src/daemon/verbs.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)
const noDir = (): boolean => false
const dirNamed = (name: string) => (p: string): boolean => p === name

//
section('(1) the grammar')
{
  check('bare ⇒ run for the current folder', JSON.stringify(parseDaemonVerb([], noDir)) === JSON.stringify({ kind: 'run', args: [] }))
  check('run ⇒ run with no dir', JSON.stringify(parseDaemonVerb(['run'], noDir)) === JSON.stringify({ kind: 'run', args: [] }))
  check('run <dir> ⇒ run carrying the dir', JSON.stringify(parseDaemonVerb(['run', '/srv/x'], noDir)) === JSON.stringify({ kind: 'run', args: ['/srv/x'] }))
  check('status', parseDaemonVerb(['status'], noDir).kind === 'status')
  const stop = parseDaemonVerb(['stop', '--keep'], noDir)
  check('stop carries its flags', stop.kind === 'stop' && JSON.stringify(stop.args) === JSON.stringify(['--keep']))
  check('restart', parseDaemonVerb(['restart'], noDir).kind === 'restart')
  for (const spelling of ['help', '--help', '-h']) {
    check(`${spelling} ⇒ help (never the supervisor)`, parseDaemonVerb([spelling], noDir).kind === 'help')
  }
  const start = parseDaemonVerb(['start'], noDir)
  check('`start` is REFUSED (it used to schedule ./start)', start.kind === 'unknown' && start.word === 'start')
  const frob = parseDaemonVerb(['--frob'], noDir)
  check('an unknown flag is REFUSED, not a supervisor start', frob.kind === 'unknown' && frob.word === '--frob')
  check('an absolute path positional is still `run <dir>` (documented back-compat)', JSON.stringify(parseDaemonVerb(['/srv/proj'], noDir)) === JSON.stringify({ kind: 'run', args: ['/srv/proj'] }))
  check('a Windows drive path positional reads as a dir on any host', parseDaemonVerb(['C:\\proj'], noDir).kind === 'run')
  check('a separator-bearing relative path reads as a dir', parseDaemonVerb(['./proj'], noDir).kind === 'run')
  check('a bare EXISTING directory name reads as a dir', parseDaemonVerb(['proj'], dirNamed('proj')).kind === 'run')
  check('the same bare name with no such directory is refused', parseDaemonVerb(['proj'], noDir).kind === 'unknown')
  check('looksLikeDirectoryArg never accepts a flag', !looksLikeDirectoryArg('-x', () => true))
  check('the usage names every verb', ['run', 'status', 'stop', 'restart', '--help'].every(v => DAEMON_USAGE.includes(v)))
}

//
section('(2) daemonMain rides the grammar')
{
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  const body = main.slice(main.indexOf('export async function daemonMain('), main.indexOf('async function daemonStatusCmd('))
  check('daemonMain parses through parseDaemonVerb', body.includes('parseDaemonVerb(args)'))
  check('help prints the usage', body.includes("case 'help'") && body.includes('console.log(DAEMON_USAGE)'))
  check('unknown sets a non-zero exit and returns before daemonRun', /case 'unknown':[\s\S]*?process\.exitCode = 1[\s\S]*?return[\s\S]*?case 'run':/.test(body))
  check('no fall-through `args` reaches daemonRun any more', !/daemonRun\(runArgs\)/.test(body) && body.includes('daemonRun(verb.args)'))
}

//
section('(3) the owned-daemon spawn says what it means')
{
  const owned = readFileSync(join(ROOT, 'src', 'daemon', 'ownedDaemon.ts'), 'utf8')
  check("spawnOwnedDaemon passes ['daemon', 'run', projectDir]", owned.includes("[script, 'daemon', 'run', projectDir]"))
}

//
section('(4) stop sweeps only a dead record; status tells the socket\'s truth')
{
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  const stop = main.slice(main.indexOf('async function daemonStopCmd('), main.indexOf('async function daemonRestartCmd('))
  check('ENOCONN reads the record before deciding', /ENOCONN[\s\S]*?readSupervisorState\(\)/.test(stop))
  check('the sweep is gated on the recorded pid being GONE (ownerWatch.isProcessAlive — ESRCH is the only "gone")', /if \(stale && !isProcessAlive\(stale\.pid\)\) \{\s*await clearDeadSupervisorRecords\(\)/.test(stop))
  check('a live-but-silent pid is never swept (it may be binding)', /else if \(stale\) \{[\s\S]*?alive[\s\S]*?process\.exitCode = 1/.test(stop))
  const status = readFileSync(join(ROOT, 'src', 'daemon', 'status.ts'), 'utf8')
  check('the headline says "running" only when the socket answers', status.includes('status.controlReachable\n        ? `  supervisor:   running') && status.includes('record present, not answering'))
  check('win32 names its control pipe', status.includes("process.platform === 'win32' ? 'control pipe:' : 'control.sock:'"))
}

//
section('(5) identity beyond the pid — the ENOCONN stop sweeps only a RECYCLED pid')
{
  const t0 = Date.UTC(2026, 7, 27, 8, 30, 12) // 2026-08-27T08:30:12Z
  check('the win32 CIM token parses, offset minutes honoured', startTokenEpochMs('20260827093012.123456+060') === t0 + 123, String(startTokenEpochMs('20260827093012.123456+060')))
  check('a CIM token with an unknown zone (+***) reads as UTC', startTokenEpochMs('20260827083012.000000+***') === t0)
  const posix = startTokenEpochMs('Wed Aug 27 09:30:12 2026')
  check('the POSIX lstart token parses (local time)', posix !== null && posix === Date.parse('Aug 27 09:30:12 2026'), String(posix))
  check('emptiness and garbage read as unknown, never a verdict', startTokenEpochMs('') === null && startTokenEpochMs('Get-CimInstance : Access denied') === null)
  const stamped = Date.UTC(2026, 7, 27, 9, 0, 0)
  check('born AFTER the record plus skew ⇒ a recycled pid ⇒ sweep', staleStopVerdict(stamped, stamped + START_TOKEN_SKEW_MS + 1) === 'sweep-recycled')
  check('born at-or-before the record (skew included) ⇒ the supervisor itself ⇒ refuse alive', staleStopVerdict(stamped, stamped - 60_000) === 'alive-refuse' && staleStopVerdict(stamped, stamped + START_TOKEN_SKEW_MS) === 'alive-refuse')
  check('an unreadable identity ⇒ refuse UNKNOWN', staleStopVerdict(stamped, null) === 'unknown-refuse')
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  const stop = main.slice(main.indexOf('async function daemonStopCmd('), main.indexOf('async function daemonRestartCmd('))
  check('the alive arm consults the ONE identity owner through the LIVE start token', stop.includes('supervisorRecordIdentity(stale, getProcessStartToken(stale.pid))'))
  check('the recycled arm sweeps through clearDeadSupervisorRecords', /not-recorded-process'\)[\s\S]{0,140}clearDeadSupervisorRecords\(\)/.test(stop))
  check('the unknown arm never prescribes a by-hand kill', !/could not be read[^\n]*end that process/.test(stop))
  check('only the identity-MATCHED arm keeps the by-hand line', (stop.match(/end that process by hand/g) ?? []).length === 1 && /IS the recorded supervisor[^\n]*end that process by hand/.test(stop))
}

//
section('(5b) THE ONE IDENTITY OWNER — supervisorRecordIdentity unions the two D arms (the convergence ruling)')
{
  // THE BASELINE ARM: a record with its own startToken is judged byte-equal
  // against the live token — exact, no parsing, no skew.
  const rec = { startedAt: Date.UTC(2026, 7, 28, 9, 0, 0), startToken: 'Thu Aug 28 08:59:58 2026' }
  check('baseline byte-equal ⇒ the recorded daemon', supervisorRecordIdentity(rec, 'Thu Aug 28 08:59:58 2026') === 'same-process')
  check('baseline mismatch ⇒ NOT the recorded process (a recycled pid, whatever its birth time parses to)', supervisorRecordIdentity(rec, 'Thu Aug 28 08:00:00 2026') === 'not-recorded-process')
  check("a pid gone inside the probe window ('' vs a baseline) ⇒ not the recorded process", supervisorRecordIdentity(rec, '') === 'not-recorded-process')
  check('a glitched probe (null) under a baseline ⇒ unknown, never a sweep verdict', supervisorRecordIdentity(rec, null) === 'unknown')
  // THE FALLBACK ARM (pre-token records; the retirement is named in the
  // owner's doc): the verifier's birth-time judgment, verbatim semantics.
  const pre = { startedAt: Date.UTC(2026, 7, 28, 9, 0, 0) }
  const bornAfter = new Date(pre.startedAt + START_TOKEN_SKEW_MS + 60_000).toUTCString()
  const bornBefore = new Date(pre.startedAt - 60_000).toUTCString()
  check('pre-token record + a process born after the stamp plus skew ⇒ not the recorded process', supervisorRecordIdentity(pre, bornAfter) === 'not-recorded-process')
  check('pre-token record + a process born at-or-before ⇒ the recorded daemon', supervisorRecordIdentity(pre, bornBefore) === 'same-process')
  check('pre-token record + an unparseable or absent token ⇒ unknown', supervisorRecordIdentity(pre, 'Get-CimInstance : Access denied') === 'unknown' && supervisorRecordIdentity(pre, null) === 'unknown' && supervisorRecordIdentity({ ...pre, startToken: null }, null) === 'unknown')
  check('an explicit null baseline takes the fallback arm (a boot whose probe failed still gets the birth-time judgment)', supervisorRecordIdentity({ ...pre, startToken: null }, bornAfter) === 'not-recorded-process')
  // THE POISON (two independent liveness judgments in src): both call sites
  // consult THE owner; the fallback's internals are called nowhere in src
  // outside the owner's own module.
  const reconcile = readFileSync(join(ROOT, 'src', 'daemon', 'reconcileRecords.ts'), 'utf8')
  check('the boot reconcile consults the ONE owner', reconcile.includes('supervisorRecordIdentity(sup, await getProcessStartTokenAsync(sup.pid))'))
  check('the reconcile keeps the conservative polarity (only a not-recorded verdict falls through to the sweep gates)', reconcile.includes("if (verdict !== 'not-recorded-process') {"))
  const srcMain = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  check('POISON: no second judgment — main.ts consults the owner and never calls the fallback internals directly', srcMain.includes('supervisorRecordIdentity(') && !srcMain.includes('staleStopVerdict(') && !srcMain.includes('startTokenEpochMs('))
  check('POISON: the reconcile never re-implements the byte-compare beside the owner', !reconcile.includes('ownerIdentityMatches('))
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DAEMON VERB GRAMMAR PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
