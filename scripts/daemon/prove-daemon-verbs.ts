#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

section('(1) the grammar')
{
  check('bare ⇒ run for the current folder', JSON.stringify(parseDaemonVerb([], noDir)) === JSON.stringify({ kind: 'run', args: [] }))
  check('run ⇒ run with no dir', JSON.stringify(parseDaemonVerb(['run'], noDir)) === JSON.stringify({ kind: 'run', args: [] }))
  check('run <dir> ⇒ run carrying the dir', JSON.stringify(parseDaemonVerb(['run', '/srv/x'], noDir)) === JSON.stringify({ kind: 'run', args: ['/srv/x'] }))
  check('status', parseDaemonVerb(['status'], noDir).kind === 'status')
  check('stop', parseDaemonVerb(['stop'], noDir).kind === 'stop')
  const keep = parseDaemonVerb(['stop', '--keep'], noDir)
  check("stop --keep is REFUSED, typed, naming the flag (nothing keeps a worker: the daemon's teardown ends every one)", keep.kind === 'unknown-flag' && keep.verb === 'stop' && keep.word === '--keep', `accepted as ${JSON.stringify(keep)}`)
  const any = parseDaemonVerb(['stop', '--any'], noDir)
  check('stop --any is REFUSED the same way (the reap is the default; it needs no flag)', any.kind === 'unknown-flag' && any.word === '--any', `accepted as ${JSON.stringify(any)}`)
  const stopRow = DAEMON_USAGE.split('\n').find(l => l.trimStart().startsWith('stop')) ?? ''
  check('the usage carries no --keep and no --any', !DAEMON_USAGE.includes('--keep') && !DAEMON_USAGE.includes('--any'), stopRow)
  check("the usage's stop row says the in-flight workers are reaped, never that any survives", /reap/.test(stopRow) && !/leaves? [^\n]*running|surviv|stay alive|keep running|live on|skips that reap/i.test(stopRow), stopRow)
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

section('(2) daemonMain rides the grammar')
{
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  const body = main.slice(main.indexOf('export async function daemonMain('), main.indexOf('async function daemonStatusCmd('))
  check('daemonMain parses through parseDaemonVerb', body.includes('parseDaemonVerb(args)'))
  check('help prints the usage', body.includes("case 'help'") && body.includes('console.log(DAEMON_USAGE)'))
  check('unknown sets a non-zero exit and returns before daemonRun', /case 'unknown':[\s\S]*?process\.exitCode = 1[\s\S]*?return[\s\S]*?case 'run':/.test(body))
  check('no fall-through `args` reaches daemonRun any more', !/daemonRun\(runArgs\)/.test(body) && body.includes('daemonRun(verb.args)'))
  check("an unknown stop flag refuses with the typed line — `unknown flag '<word>'` and the usage, exit 1 — naming the bare stop and the restart to run instead", /case 'unknown-flag':[\s\S]*?unknown flag '\$\{verb\.word\}'[^\n]*mercury daemon stop[^\n]*mercury daemon restart[^\n]*\$\{DAEMON_USAGE\}[\s\S]*?process\.exitCode = 1[\s\S]*?return/.test(body), 'no unknown-flag arm in daemonMain')
  check('the stop verb is called with no flags to read', body.includes('return daemonStopCmd()'))
}

section('(3) the owned-daemon spawn says what it means')
{
  const owned = readFileSync(join(ROOT, 'src', 'daemon', 'ownedDaemon.ts'), 'utf8')
  check("spawnOwnedDaemon passes ['daemon', 'run', projectDir]", owned.includes("[script, 'daemon', 'run', projectDir]"))
}

section('(4) stop sweeps only a dead record; status tells the socket\'s truth')
{
  const main = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  const stop = main.slice(main.indexOf('async function daemonStopCmd('), main.indexOf('async function daemonRestartCmd('))
  check('the stop verb asks for the reap by name — always — and reads no --keep or --any', stop.includes("{ op: 'shutdown', reapWorkers: true }") && !stop.includes('--keep') && !stop.includes('--any'), stop.split('\n').filter(l => /--keep|--any|reapWorkers/.test(l)).join(' | '))
  check('ENOCONN reads the record before deciding', /ENOCONN[\s\S]*?readSupervisorState\(\)/.test(stop))
  check('the sweep is gated on the recorded pid being GONE (ownerWatch.isProcessAlive — ESRCH is the only "gone")', /if \(stale && !isProcessAlive\(stale\.pid\)\) \{\s*await clearDeadSupervisorRecords\(\)/.test(stop))
  check('a live-but-silent pid is never swept (it may be binding)', /else if \(stale\) \{[\s\S]*?alive[\s\S]*?process\.exitCode = 1/.test(stop))
  const status = readFileSync(join(ROOT, 'src', 'daemon', 'status.ts'), 'utf8')
  check('the headline says "running" only when the socket answers', status.includes('status.controlReachable\n        ? `  supervisor:   running') && status.includes('record present, not answering'))
  check('win32 names its control pipe', status.includes("process.platform === 'win32' ? 'control pipe:' : 'control.sock:'"))
}

section('(5) identity beyond the pid — the ENOCONN stop sweeps only a RECYCLED pid')
{
  const t0 = Date.UTC(2026, 7, 27, 8, 30, 12)
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

section('(5b) THE ONE IDENTITY OWNER — supervisorRecordIdentity unions the two D arms (the convergence ruling)')
{
  const rec = { startedAt: Date.UTC(2026, 7, 28, 9, 0, 0), startToken: 'Thu Aug 28 08:59:58 2026' }
  check('baseline byte-equal ⇒ the recorded daemon', supervisorRecordIdentity(rec, 'Thu Aug 28 08:59:58 2026') === 'same-process')
  check('baseline mismatch ⇒ NOT the recorded process (a recycled pid, whatever its birth time parses to)', supervisorRecordIdentity(rec, 'Thu Aug 28 08:00:00 2026') === 'not-recorded-process')
  check("a pid gone inside the probe window ('' vs a baseline) ⇒ not the recorded process", supervisorRecordIdentity(rec, '') === 'not-recorded-process')
  check('a glitched probe (null) under a baseline ⇒ unknown, never a sweep verdict', supervisorRecordIdentity(rec, null) === 'unknown')
  const pre = { startedAt: Date.UTC(2026, 7, 28, 9, 0, 0) }
  const bornAfter = new Date(pre.startedAt + START_TOKEN_SKEW_MS + 60_000).toUTCString()
  const bornBefore = new Date(pre.startedAt - 60_000).toUTCString()
  check('pre-token record + a process born after the stamp plus skew ⇒ not the recorded process', supervisorRecordIdentity(pre, bornAfter) === 'not-recorded-process')
  check('pre-token record + a process born at-or-before ⇒ the recorded daemon', supervisorRecordIdentity(pre, bornBefore) === 'same-process')
  check('pre-token record + an unparseable or absent token ⇒ unknown', supervisorRecordIdentity(pre, 'Get-CimInstance : Access denied') === 'unknown' && supervisorRecordIdentity(pre, null) === 'unknown' && supervisorRecordIdentity({ ...pre, startToken: null }, null) === 'unknown')
  check('an explicit null baseline takes the fallback arm (a boot whose probe failed still gets the birth-time judgment)', supervisorRecordIdentity({ ...pre, startToken: null }, bornAfter) === 'not-recorded-process')
  const reconcile = readFileSync(join(ROOT, 'src', 'daemon', 'reconcileRecords.ts'), 'utf8')
  check('the boot reconcile consults the ONE owner', reconcile.includes('supervisorRecordIdentity(sup, await getProcessStartTokenAsync(sup.pid))'))
  check('the reconcile keeps the conservative polarity (only a not-recorded verdict falls through to the sweep gates)', reconcile.includes("if (verdict !== 'not-recorded-process') {"))
  const srcMain = readFileSync(join(ROOT, 'src', 'daemon', 'main.ts'), 'utf8')
  check('POISON: no second judgment — main.ts consults the owner and never calls the fallback internals directly', srcMain.includes('supervisorRecordIdentity(') && !srcMain.includes('staleStopVerdict(') && !srcMain.includes('startTokenEpochMs('))
  check('POISON: the reconcile never re-implements the byte-compare beside the owner', !reconcile.includes('ownerIdentityMatches('))
}

section('(6) the verb road, live in a scratch home: `stop --keep` and `stop --any` refuse before any record read or RPC; a bare `stop` takes the stop road')
{
  const home = mkdtempSync(join(tmpdir(), 'daemon-verbs-'))
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_DAEMON_DIR: join(home, 'daemon'), MERCURY_CREDENTIAL_STORE: 'file' }
  delete env.MERCURY_HOME
  const client = (...args: string[]): { status: number | null; text: string } => {
    const r = spawnSync(process.execPath, ['run', join(ROOT, 'scripts', 'daemon', 'hosted-caller-client.ts'), ...args], { env, encoding: 'utf8', timeout: 30_000 })
    return { status: r.status, text: `${r.stderr}${r.stdout}` }
  }
  const firstLine = (t: string): string => t.trim().split('\n')[0] ?? ''
  const keep = client('stop', '--keep')
  check("`stop --keep` refuses: exit 1, `unknown flag '--keep'`, the usage, and the two things to run instead", keep.status === 1 && keep.text.includes("mercury daemon stop: unknown flag '--keep'") && keep.text.includes('usage: mercury daemon') && keep.text.includes('`mercury daemon stop`') && keep.text.includes('`mercury daemon restart`'), `exit ${keep.status}: ${firstLine(keep.text)}`)
  check('…and the usage it prints carries no --keep', !keep.text.replace("unknown flag '--keep'", '').includes('--keep'), keep.text.split('\n').find(l => l.includes('--keep') && !l.includes('unknown flag')) ?? '')
  const any = client('stop', '--any')
  check('`stop --any` refuses the same way', any.status === 1 && any.text.includes("mercury daemon stop: unknown flag '--any'"), `exit ${any.status}: ${firstLine(any.text)}`)
  const bare = client('stop')
  check('a bare `stop` takes the stop road (no supervisor in the scratch home: nothing to stop, exit 0)', bare.status === 0 && bare.text.includes('no running supervisor to stop'), `exit ${bare.status}: ${firstLine(bare.text)}`)
  rmSync(home, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DAEMON VERB GRAMMAR PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
