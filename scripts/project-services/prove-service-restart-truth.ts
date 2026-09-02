#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'prove-svc-restart-home-'))
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
type Rec = Record<string, unknown>
const { readRecord, servicesDir, startService, stopService, restartService } = manager as unknown as {
  readRecord: (cwd: string, name: string) => Rec | null
  servicesDir: (cwd: string) => string
  startService: (a: { sessionId: string; spec: Rec }) => Promise<Rec>
  stopService: (cwd: string, name: string) => Promise<Rec>
  restartService: (cwd: string, name: string, sessionId: string) => Promise<Rec>
}
const decideServiceStrike = (manager as Rec).decideServiceStrike as
  | ((facts: { pid: number | null; startToken: string | null; currentToken: string | null; ownedHandle?: boolean }) => string)
  | undefined
function writeRecord(cwd: string, record: Rec): void {
  const name = (record.spec as { name: string }).name
  writeFileSync(join(servicesDir(cwd), `${name}.json`), JSON.stringify(record, null, 2))
}
const spec = (cwd: string, name: string, script = 'setTimeout(() => {}, 30000)'): Rec => ({
  name,
  command: process.execPath,
  args: ['-e', script],
  cwd,
  readiness: [],
  readinessMode: 'all',
  restart: 'never',
  lifecycle: 'session',
})

const workDir = mkdtempSync(join(tmpdir(), 'prove-svc-restart-'))
const NODE = process.execPath
const SESSION = 'restart-truth'
const guard = setTimeout(() => {
  console.log('\n TIMEOUT — the restart proof exceeded 120s')
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
const kill = (pid: number | undefined | null): void => {
  try {
    if (pid) process.kill(pid, 'SIGKILL')
  } catch {
  }
}

console.log('============================================================')
console.log(' a restart tells the truth about the stop it rode on')
console.log('============================================================')

section('§1 decideServiceStrike — a held child is a strike without a probe')
{
  check('the pure decision is exported', typeof decideServiceStrike === 'function')
  if (decideServiceStrike) {
    const d = decideServiceStrike
    check('a held child with NO token and NO probe ⇒ STRIKE (the handle is the identity)', d({ pid: 4242, startToken: null, currentToken: null, ownedHandle: true }) === 'strike')
    check('a held child beats a probe that could not answer', d({ pid: 4242, startToken: 'x', currentToken: null, ownedHandle: true }) === 'strike')
    check('no pid is still nothing to strike, handle or not', d({ pid: null, startToken: null, currentToken: null, ownedHandle: true }) === 'no-process')
    check('the old table stands: no token, no handle ⇒ refuse', d({ pid: 4242, startToken: null, currentToken: 'x' }) === 'refuse-unverified')
    check('…and a false handle claim changes nothing', d({ pid: 4242, startToken: null, currentToken: 'x', ownedHandle: false }) === 'refuse-unverified')
  }
}

section('§2 a restart whose stop cannot prove the pid FAILS and starts nothing')
{
  const bystander = spawn(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true, env: { ...process.env } })
  await sleep(400)
  check('the bystander is running', bystander.pid !== undefined && alive(bystander.pid))
  await startService({ sessionId: SESSION, spec: spec(workDir, 'foreign') })
  const real = readRecord(workDir, 'foreign')
  const realPid = Number(real?.pid)
  check('the real service started', Number.isInteger(realPid) && realPid > 0)
  writeRecord(workDir, { ...(real as Rec), pid: bystander.pid, startToken: null, state: 'running', restartCount: 3 })

  const result = await restartService(workDir, 'foreign', SESSION)
  const error = String((result as { error?: string }).error ?? '')
  check('THE RESTART FAILS (the base returned a record and printed "restarted")', 'error' in result, JSON.stringify(result))
  check('…as a restart failure the tool classifies as one', /^restart failed:/.test(error), error || '(no error)')
  check('…that carries the refusal (the pid could not be confirmed)', /could not be confirmed|not force-stopped/.test(error), error)
  const after = readRecord(workDir, 'foreign')
  check('NO SECOND COPY: the record is stopped with no pid', after?.state === 'stopped' && after?.pid === null, `${String(after?.state)} pid=${String(after?.pid)}`)
  check('the restart count did not bump', after?.restartCount === 3, String(after?.restartCount))
  check('the bystander survives', bystander.pid !== undefined && alive(bystander.pid))
  check('the refusal is on the record too', /could not be confirmed/.test(String(after?.stopNote ?? '')), String(after?.stopNote))
  kill(bystander.pid)
  kill(realPid)
}

section('§3 a service this session spawned with no token on its record is stopped and restarted honestly')
{
  await startService({ sessionId: SESSION, spec: spec(workDir, 'mine') })
  await sleep(300)
  const first = readRecord(workDir, 'mine')
  const firstPid = Number(first?.pid)
  check('the service is running', Number.isInteger(firstPid) && firstPid > 0 && alive(firstPid))
  writeRecord(workDir, { ...(first as Rec), startToken: null })
  check('the record carries no token (the fixture)', readRecord(workDir, 'mine')?.startToken === null)

  const restarted = await restartService(workDir, 'mine', SESSION)
  const record = (restarted as { record?: Rec }).record
  check('THE RESTART SUCCEEDS (the base refused the stop and started a second copy)', record !== undefined, JSON.stringify(restarted))
  const secondPid = Number(record?.pid)
  check('the service came back on a NEW pid', Number.isInteger(secondPid) && secondPid > 0 && secondPid !== firstPid, `${firstPid} → ${secondPid}`)
  {
    const deadline = Date.now() + 5000
    while (alive(firstPid) && Date.now() < deadline) await sleep(50)
  }
  check('THE OLD PROCESS IS GONE (the strike ran: the handle proved it ours)', !alive(firstPid))
  check('the restart count bumped once', record?.restartCount === 1, String(record?.restartCount))
  check('no refusal note rode the record', (readRecord(workDir, 'mine') as Rec | null)?.stopNote === undefined)

  writeRecord(workDir, { ...(readRecord(workDir, 'mine') as Rec), startToken: null })
  const stopped = await stopService(workDir, 'mine')
  {
    const deadline = Date.now() + 5000
    while (alive(secondPid) && Date.now() < deadline) await sleep(50)
  }
  check('a plain stop over the token-less record ends the process', !alive(secondPid))
  check('…with no refusal', (stopped as { note?: string }).note === undefined, String((stopped as { note?: string }).note))
  kill(firstPid)
  kill(secondPid)
}

section('§4 the token backfill retries a probe that could not answer')
{
  const emptyDir = join(workDir, 'empty-path')
  mkdirSync(emptyDir, { recursive: true })
  const savedPath = process.env.PATH
  process.env.PATH = emptyDir
  let started: Rec
  try {
    started = await startService({ sessionId: SESSION, spec: spec(workDir, 'late') })
  } finally {
    setTimeout(() => {
      process.env.PATH = savedPath
    }, 300).unref?.()
  }
  const record = (started as { record?: Rec }).record
  const pid = Number(record?.pid)
  check('the service started with no identity token (the probe could not run)', record !== undefined && record?.startToken === null, JSON.stringify(record?.startToken))
  let token: unknown = null
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    token = readRecord(workDir, 'late')?.startToken ?? null
    if (typeof token === 'string' && token.length > 0) break
    await sleep(100)
  }
  process.env.PATH = savedPath
  check('THE TOKEN LANDS ON THE RECORD once the probe can answer (the base gave the backfill one shot)', typeof token === 'string' && token.length > 0, 'still null after 8s')
  await stopService(workDir, 'late')
  kill(pid)
}

section('§5 the shape')
{
  const src = readFileSync(join(ROOT, 'src/services/projectServices/serviceManager.ts'), 'utf8')
  const restart = src.slice(src.indexOf('export async function restartService'), src.indexOf('export function sendInput'))
  check('restartService consults the stop\'s refusal note before starting', /stopped\.note !== undefined/.test(restart) && restart.indexOf('stopped.note') < restart.indexOf('await startService('))
  check('…and answers a restart failure', /restart failed:/.test(restart))
  check('the strike decision takes the held handle as identity', /ownedHandle/.test(src) && /liveChildren\.get\(childKey\(cwd, name\)\)/.test(src))
  check('the backfill has a bounded retry ladder', /TOKEN_BACKFILL_RETRY_MS/.test(src))
}

rmSync(workDir, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-service-restart-truth${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
