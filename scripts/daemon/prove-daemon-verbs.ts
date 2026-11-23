#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DAEMON_USAGE, looksLikeDirectoryArg, parseDaemonVerb, START_TOKEN_SKEW_MS, staleStopVerdict, startTokenEpochMs, daemonRecordIdentity } from '../../src/daemon/control/verbs.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond ? '' : ` — ${detail ? `${detail}; ` : ''}fix: src/daemon/control/verbs.ts (parseDaemonVerb, DAEMON_USAGE, staleStopVerdict, daemonRecordIdentity); the live-verb checks of section 6 run scripts/daemon/hosted-caller-client.ts`}`)
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
  const usageLines = DAEMON_USAGE.split('\n')
  const stopAt = usageLines.findIndex(l => l.trimStart().startsWith('stop'))
  const stopRow = usageLines.slice(stopAt, stopAt + 2).filter((l, i) => i === 0 || /^\s{8,}\S/.test(l)).join(' ').replace(/\s+/g, ' ')
  check('the usage carries no --keep and no --any', !DAEMON_USAGE.includes('--keep') && !DAEMON_USAGE.includes('--any'), stopRow)
  check("the usage's stop row says every worker stops with the daemon, never that any survives", /every session process it runs \(every worker\) stops with it/.test(stopRow) && !/leaves? [^\n]*running|surviv|stay alive|keep running|live on|skips that reap/i.test(stopRow), stopRow)
  check('restart', parseDaemonVerb(['restart'], noDir).kind === 'restart')
  for (const verb of ['run', 'status', 'stop', 'restart']) {
    check(`${verb} --help ⇒ help (never the daemon)`, parseDaemonVerb([verb, '--help'], noDir).kind === 'help' && parseDaemonVerb([verb, '-h'], noDir).kind === 'help')
  }
  const runFlag = parseDaemonVerb(['run', '--frobnicate'], noDir)
  check('run --frobnicate is REFUSED as an unknown flag, never a scheduling directory', runFlag.kind === 'unknown-flag' && runFlag.verb === 'run' && runFlag.word === '--frobnicate', JSON.stringify(runFlag))
  const statusFlag = parseDaemonVerb(['status', '--json'], noDir)
  check('status takes no flags', statusFlag.kind === 'unknown-flag' && statusFlag.verb === 'status')
  for (const spelling of ['help', '--help', '-h']) {
    check(`${spelling} ⇒ help (never the daemon)`, parseDaemonVerb([spelling], noDir).kind === 'help')
  }
  const start = parseDaemonVerb(['start'], noDir)
  check('`start` is REFUSED (it used to schedule ./start)', start.kind === 'unknown' && start.word === 'start')
  const frob = parseDaemonVerb(['--frob'], noDir)
  check('an unknown flag is REFUSED, not a daemon start', frob.kind === 'unknown' && frob.word === '--frob')
  check('an absolute path positional is still `run <dir>` (documented back-compat)', JSON.stringify(parseDaemonVerb(['/srv/proj'], noDir)) === JSON.stringify({ kind: 'run', args: ['/srv/proj'] }))
  check('a Windows drive path positional reads as a dir on any host', parseDaemonVerb(['C:\\proj'], noDir).kind === 'run')
  check('a separator-bearing relative path reads as a dir', parseDaemonVerb(['./proj'], noDir).kind === 'run')
  check('a bare EXISTING directory name reads as a dir', parseDaemonVerb(['proj'], dirNamed('proj')).kind === 'run')
  check('the same bare name with no such directory is refused', parseDaemonVerb(['proj'], noDir).kind === 'unknown')
  check('looksLikeDirectoryArg never accepts a flag', !looksLikeDirectoryArg('-x', () => true))
  check('the usage names every verb', ['run', 'status', 'stop', 'restart', '--help'].every(v => DAEMON_USAGE.includes(v)))
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
  check('born at-or-before the record (skew included) ⇒ the daemon itself ⇒ refuse alive', staleStopVerdict(stamped, stamped - 60_000) === 'alive-refuse' && staleStopVerdict(stamped, stamped + START_TOKEN_SKEW_MS) === 'alive-refuse')
  check('an unreadable identity ⇒ refuse UNKNOWN', staleStopVerdict(stamped, null) === 'unknown-refuse')
}

section('(5b) THE ONE IDENTITY OWNER — daemonRecordIdentity unions the two D arms (the convergence ruling)')
{
  const rec = { startedAt: Date.UTC(2026, 7, 28, 9, 0, 0), startToken: 'Thu Aug 28 08:59:58 2026' }
  check('baseline byte-equal ⇒ the recorded daemon', daemonRecordIdentity(rec, 'Thu Aug 28 08:59:58 2026') === 'same-process')
  check('baseline mismatch ⇒ NOT the recorded process (a recycled pid, whatever its birth time parses to)', daemonRecordIdentity(rec, 'Thu Aug 28 08:00:00 2026') === 'not-recorded-process')
  check("a pid gone inside the probe window ('' vs a baseline) ⇒ not the recorded process", daemonRecordIdentity(rec, '') === 'not-recorded-process')
  check('a glitched probe (null) under a baseline ⇒ unknown, never a sweep verdict', daemonRecordIdentity(rec, null) === 'unknown')
  const pre = { startedAt: Date.UTC(2026, 7, 28, 9, 0, 0) }
  const bornAfter = new Date(pre.startedAt + START_TOKEN_SKEW_MS + 60_000).toUTCString()
  const bornBefore = new Date(pre.startedAt - 60_000).toUTCString()
  check('pre-token record + a process born after the stamp plus skew ⇒ not the recorded process', daemonRecordIdentity(pre, bornAfter) === 'not-recorded-process')
  check('pre-token record + a process born at-or-before ⇒ the recorded daemon', daemonRecordIdentity(pre, bornBefore) === 'same-process')
  check('pre-token record + an unparseable or absent token ⇒ unknown', daemonRecordIdentity(pre, 'Get-CimInstance : Access denied') === 'unknown' && daemonRecordIdentity(pre, null) === 'unknown' && daemonRecordIdentity({ ...pre, startToken: null }, null) === 'unknown')
  check('an explicit null baseline takes the fallback arm (a boot whose probe failed still gets the birth-time judgment)', daemonRecordIdentity({ ...pre, startToken: null }, bornAfter) === 'not-recorded-process')
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
  check("`stop --keep` refuses: exit 1, `unknown flag '--keep'`, the usage, and the two things to run instead", keep.status === 1 && keep.text.includes("mercury daemon stop: unknown flag '--keep'") && keep.text.includes('Usage: mercury daemon') && keep.text.includes('`mercury daemon stop`') && keep.text.includes('`mercury daemon restart`'), `exit ${keep.status}: ${firstLine(keep.text)}`)
  check('…and the usage it prints carries no --keep', !keep.text.replace("unknown flag '--keep'", '').includes('--keep'), keep.text.split('\n').find(l => l.includes('--keep') && !l.includes('unknown flag')) ?? '')
  check("…and the refusal says what the usage's stop row says: every session process it runs (every worker) stops with it", firstLine(keep.text).includes('it ends the daemon and every session process it runs (every worker) stops with it'), firstLine(keep.text))
  const any = client('stop', '--any')
  check('`stop --any` refuses the same way', any.status === 1 && any.text.includes("mercury daemon stop: unknown flag '--any'"), `exit ${any.status}: ${firstLine(any.text)}`)
  const bare = client('stop')
  check('a bare `stop` takes the stop road (no daemon in the scratch home: nothing to stop, exit 0)', bare.status === 0 && bare.text.includes('no running daemon to stop'), `exit ${bare.status}: ${firstLine(bare.text)}`)
  rmSync(home, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ DAEMON VERB GRAMMAR PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
