#!/usr/bin/env bun
// ============================================================================
//  scripts/project-services/prove-service-stop-ownership.ts — a service stop
//  never force-kills a tree it cannot confirm is its own (FN-015 rank 6, S1).
//
//  The stop escalation ran `taskkill /PID <recorded pid> /T /F` (win32) or a
//  tree SIGKILL (posix) against whatever process now holds the recorded pid.
//  `startToken` — the identity that pairs with the pid — is null whenever the
//  spawn-time probe missed its budget, which on a 7200rpm Windows box is
//  routine: a two-second spawnSync of pwsh with a CIM query. The user asked
//  to restart a dev server and an UNRELATED program and its whole descendant
//  tree were force-terminated with no warning.
//
//   §1 the pure ownership decision (a table, both platforms)
//   §2 LIVE: a record whose pid belongs to a BYSTANDER with no identity
//      token — the stop refuses to strike, says so, and the bystander and
//      its child are both still alive afterwards
//   §3 LIVE: a record whose token DISAGREES with the live pid's — the same
//      refusal (a definitively reused pid)
//   §4 LIVE: the honest case still works — a real service with a real token
//      is stopped, tree and all
//   §5 the token is captured without a blocking probe, and no strike site
//      is left ungated
//
//  Run:  ~/.bun/bin/bun run scripts/project-services/prove-service-stop-ownership.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-svc-ownership-home-'))
delete process.env.MERCURY_SERVICES

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const manager = await import('../../src/services/projectServices/serviceManager.ts')
const { readRecord, servicesDir, startService, stopService } = manager as unknown as {
  readRecord: (cwd: string, name: string) => Record<string, unknown> | null
  servicesDir: (cwd: string) => string
  startService: (a: { sessionId: string; spec: Record<string, unknown> }) => Promise<Record<string, unknown>>
  stopService: (cwd: string, name: string) => Promise<Record<string, unknown>>
}
/** Plant a record on disk — the store IS a file, and a record whose pid
 *  outlived its process is exactly the state a reused pid leaves behind. */
function writeRecord(cwd: string, record: Record<string, unknown>): void {
  const name = (record.spec as { name: string }).name
  writeFileSync(join(servicesDir(cwd), `${name}.json`), JSON.stringify(record, null, 2))
}
const decideServiceStrike = (manager as Record<string, unknown>).decideServiceStrike as
  | ((facts: { pid: number | null; startToken: string | null; currentToken: string | null }) => string)
  | undefined

const workDir = mkdtempSync(join(tmpdir(), 'prove-svc-ownership-'))
const NODE = process.execPath
const SESSION = 'ownership-proof'
const guard = setTimeout(() => {
  console.log('\n TIMEOUT — the ownership proof exceeded 120s')
  process.exit(1)
}, 120_000)
guard.unref?.()

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM'
  }
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

console.log('============================================================')
console.log(' a service stop strikes only a pid it can prove is its own')
console.log('============================================================')

// ── §1 the pure decision ────────────────────────────────────────────────────
section('§1 decideServiceStrike — the table')
{
  check('the pure decision is exported', typeof decideServiceStrike === 'function')
  if (decideServiceStrike) {
    const d = decideServiceStrike
    check('no pid ⇒ nothing to strike', d({ pid: null, startToken: 'x', currentToken: 'x' }) === 'no-process')
    check("a pid the probe reports GONE ('') ⇒ nothing to strike", d({ pid: 4242, startToken: 'x', currentToken: '' }) === 'no-process')
    check('a matching token ⇒ STRIKE (the honest case)', d({ pid: 4242, startToken: 'x', currentToken: 'x' }) === 'strike')
    check('NO recorded token ⇒ refuse (an unverifiable pid is not ours)', d({ pid: 4242, startToken: null, currentToken: 'x' }) === 'refuse-unverified')
    check('a probe that could not answer (null) ⇒ refuse (never strike on a guess)', d({ pid: 4242, startToken: 'x', currentToken: null }) === 'refuse-unverified')
    check('a token that DISAGREES ⇒ refuse (the pid was reused)', d({ pid: 4242, startToken: 'x', currentToken: 'y' }) === 'refuse-reused')
    check('both unknown ⇒ refuse', d({ pid: 4242, startToken: null, currentToken: null }) === 'refuse-unverified')
  }
}

// ── §2 LIVE: an unverifiable pid belonging to a bystander ───────────────────
section('§2 a record pointing at a BYSTANDER with no identity token')
{
  // The bystander is somebody else's program with its own child — exactly
  // what a reused pid looks like from the record's side.
  const bystander = spawn(NODE, ['-e', "const {spawn}=require('node:child_process'); const kid=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); console.log(kid.pid); setTimeout(()=>{},60000)"], {
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    env: { ...process.env },
  })
  let childPid = 0
  bystander.stdout?.on('data', (b: Buffer) => {
    childPid = Number(String(b).trim()) || childPid
  })
  await sleep(700)
  check('the bystander is running', bystander.pid !== undefined && alive(bystander.pid))
  check('…with a child of its own', childPid > 0 && alive(childPid), String(childPid))

  // A service record that names the bystander's pid with NO identity token —
  // the shape a Windows probe miss leaves behind.
  await startService({
    sessionId: SESSION,
    spec: {
      name: 'unverifiable',
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: workDir,
      readiness: [],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  const real = readRecord(workDir, 'unverifiable')
  const realPid = Number(real?.pid)
  check('the real service started', Number.isInteger(realPid) && realPid > 0)
  // Retarget the record at the bystander, identity unknown.
  writeRecord(workDir, { ...(real as Record<string, unknown>), pid: bystander.pid, startToken: null, state: 'running' })

  const stopped = await stopService(workDir, 'unverifiable')
  const record = (stopped as { record?: Record<string, unknown> }).record
  check('the stop returns a record (never an error)', record !== undefined, JSON.stringify(stopped))
  check('the service reads stopped afterwards', record?.state === 'stopped', String(record?.state))
  check('THE BYSTANDER SURVIVES (the base force-killed it)', bystander.pid !== undefined && alive(bystander.pid), 'an unrelated program was terminated')
  check("…and so does the bystander's child (its whole tree survives)", childPid > 0 && alive(childPid), 'an unrelated tree was terminated')
  const note = String((stopped as { note?: string }).note ?? record?.stopNote ?? '')
  check('the outcome SAYS the pid could not be confirmed (never a silent claim of a clean stop)', /could not|unverified|not confirm/i.test(note), note || '(no note)')
  check('the record no longer carries the foreign pid', record?.pid === null)

  try {
    if (bystander.pid) process.kill(bystander.pid, 'SIGKILL')
    if (childPid) process.kill(childPid, 'SIGKILL')
  } catch {
    /* cleanup */
  }
  // The real service child is still out there — end it.
  try {
    if (realPid) process.kill(realPid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

// ── §3 LIVE: a token that disagrees ─────────────────────────────────────────
section('§3 a record whose token DISAGREES with the live pid')
{
  const bystander = spawn(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env } })
  await sleep(400)
  await startService({
    sessionId: SESSION,
    spec: {
      name: 'reused',
      command: NODE,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: workDir,
      readiness: [],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  const real = readRecord(workDir, 'reused')
  const realPid = Number(real?.pid)
  writeRecord(workDir, {
    ...(real as Record<string, unknown>),
    pid: bystander.pid,
    startToken: 'a start time this process never had',
    state: 'running',
  })
  const stopped = await stopService(workDir, 'reused')
  check('THE BYSTANDER SURVIVES a definitively reused pid', bystander.pid !== undefined && alive(bystander.pid))
  const note = String((stopped as { note?: string }).note ?? (stopped as { record?: Record<string, unknown> }).record?.stopNote ?? '')
  check('the outcome names the reuse', /reuse|different process|not confirm|could not/i.test(note), note || '(no note)')
  try {
    if (bystander.pid) process.kill(bystander.pid, 'SIGKILL')
    if (realPid) process.kill(realPid, 'SIGKILL')
  } catch {
    /* cleanup */
  }
}

// ── §4 LIVE: the honest stop still ends the tree ────────────────────────────
section('§4 a service Mercury can prove is its own is still stopped, tree and all')
{
  // A service that IGNORES SIGTERM and spawns a child: the graceful phase
  // cannot end it, so the escalation is what settles it — the honest strike.
  await startService({
    sessionId: SESSION,
    spec: {
      name: 'stubborn',
      command: NODE,
      args: [
        '-e',
        "process.on('SIGTERM',()=>{}); const {spawn}=require('node:child_process'); const kid=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:'ignore'}); console.log('KID ' + kid.pid); setInterval(()=>{},1000)",
      ],
      cwd: workDir,
      readiness: [],
      readinessMode: 'all',
      restart: 'never',
      lifecycle: 'session',
    },
  })
  await sleep(900)
  const record = readRecord(workDir, 'stubborn')
  const pid = Number(record?.pid)
  check('the stubborn service is running with a recorded pid', Number.isInteger(pid) && alive(pid))
  check('its identity token was captured (no blocking probe needed)', typeof record?.startToken === 'string' && String(record?.startToken).length > 0, JSON.stringify(record?.startToken))
  // The child's pid comes off the service's own log — the record names it.
  let kidPid = 0
  for (let i = 0; i < 40 && kidPid === 0; i++) {
    try {
      const log = readFileSync(String(record?.logFile), 'utf8')
      kidPid = Number(/KID (\d+)/.exec(log)?.[1] ?? 0)
    } catch {
      /* not yet */
    }
    if (kidPid === 0) await sleep(100)
  }
  check('…and it has a child of its own', kidPid > 0 && alive(kidPid), String(kidPid))
  const stopped = await stopService(workDir, 'stubborn')
  check('the stop reports stopped', (stopped as { record?: Record<string, unknown> }).record?.state === 'stopped')
  check('the service process is gone', !alive(pid))
  if (kidPid > 0) {
    const deadline = Date.now() + 5000
    while (alive(kidPid) && Date.now() < deadline) await sleep(50)
    check('its CHILD is gone too (the strike is a tree kill)', !alive(kidPid))
    if (alive(kidPid)) process.kill(kidPid, 'SIGKILL')
  }
}

// ── §5 the shape ────────────────────────────────────────────────────────────
section('§5 no ungated strike, and the token never blocks the spawn')
{
  const src = readFileSync(join(ROOT, 'src/services/projectServices/serviceManager.ts'), 'utf8')
  const stop = src.slice(src.indexOf('export async function stopService'), src.indexOf('export async function restartService'))
  const strikes = stop.match(/endProcessTree\(/g) ?? []
  check('every strike in the stop is inside the ownership gate', strikes.length > 0 && (stop.match(/decideServiceStrike\(/g) ?? []).length >= 1)
  check("the stop never strikes on a bare pid (no endProcessTree without a preceding verdict)", !/if \(processAlive\(record\.pid, record\.startToken\)\) \{\s*await endProcessTree/.test(stop))
  check('the spawn does not block on the sync start-token probe on win32', /platform === 'win32'[\s\S]{0,120}startToken/.test(src) || /captureStartTokenAsync/.test(src))
  check('a late token lands on the record asynchronously', /getProcessStartTokenAsync/.test(src))
}

rmSync(workDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-service-stop-ownership${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
