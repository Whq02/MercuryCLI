#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'
import { DIST, NODE, REPO, SCRATCH_ROOT, bound, childEnv, makeTally, removeWorld, sleep } from './dupline-world.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startScriptedFixture, type Script } from '../lib/scriptedTurn.ts'
import type { StreamJsonChildSpec } from '../../src/daemon/headlessRun.ts'

const tally = makeTally('prove-interrupt-keeps-runner')
const world = mkdtempSync(join(SCRATCH_ROOT, 'interrupt-keeps-runner-'))
const runHome = join(world, 'home')
const daemonDir = join(runHome, 'daemon')
mkdirSync(daemonDir, { recursive: true })
process.env.MERCURY_CONFIG_DIR = runHome
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_WORKER_PARENT_PID

const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf8')
type LedgerRow = { ts: string; kind?: string; event?: string; id?: string; pid?: number; code?: number | null; signal?: string | null; outcome?: string }
const ledgerRows = (): LedgerRow[] => {
  const path = join(daemonDir, 'spawn-ledger.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as LedgerRow)
}
const rowsOf = (id: string): LedgerRow[] => ledgerRows().filter(r => r.id === id)
const isSpawnRow = (r: LedgerRow): boolean => r.kind === 'long-lived' && r.event === undefined
const isExitRow = (r: LedgerRow): boolean => r.event === 'exit'
const ms = (iso: string): number => new Date(iso).getTime()
const gapAfterExit = (rows: LedgerRow[], nth: number): { exit: LedgerRow; spawn: LedgerRow; gapMs: number } | null => {
  let seen = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    if (!isExitRow(row)) continue
    seen++
    if (seen !== nth) continue
    const next = rows.slice(i + 1).find(isSpawnRow)
    return next === undefined ? null : { exit: row, spawn: next, gapMs: ms(next.ts) - ms(row.ts) }
  }
  return null
}
const AT_ONCE_MS = 250
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (pred: () => Promise<boolean> | boolean, limitMs: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < limitMs) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(50)
  }
  return false
}

console.log('============================================================')
console.log(' esc on a hung op ends the op, never the runner; a runner that dies from outside comes back at once the first time')
console.log(' red on the base: §1 the first respawn waits the base backoff (1000 ms); §2 the roster waits it on a first death and again after healthy uptime; §4 the ledger gap between the exit row and the respawn row is a second')
console.log('============================================================')

tally.section('§1 the rule, pure: the first death in a healthy window respawns at once; the second and later keep the ladder; the ceilings stand')
{
  const { decideRespawn, longLivedBackoffMs, DEFAULT_LONG_LIVED_CONFIG } = await import('../../src/daemon/longLivedSupervisor.ts')
  const first = decideRespawn(1)
  tally.check('red on the base: the first respawn waits nothing (delayMs 0)', first.action === 'respawn' && first.delayMs === 0, JSON.stringify(first))
  const ladder = [2, 3, 4, 5].map(n => decideRespawn(n))
  tally.check('the second, third, fourth and fifth keep the ladder: 2 s, 4 s, 8 s, 16 s', ladder.every((d, i) => d.action === 'respawn' && d.delayMs === 1000 * 2 ** (i + 1)), JSON.stringify(ladder))
  tally.check('the sixth degrades, as before', decideRespawn(6).action === 'degrade', JSON.stringify(decideRespawn(6)))
  tally.check('the lifetime backstop still degrades a first death past twenty crashes', decideRespawn(1, DEFAULT_LONG_LIVED_CONFIG, 21).action === 'degrade')
  const cfg = { ...DEFAULT_LONG_LIVED_CONFIG, backoffBaseMs: 300, backoffCapMs: 700 }
  tally.check('a custom base: the first is still at once, the second the base doubled, the third the cap', longLivedBackoffMs(1, cfg) === 0 && longLivedBackoffMs(2, cfg) === 600 && longLivedBackoffMs(3, cfg) === 700, `${longLivedBackoffMs(1, cfg)} ${longLivedBackoffMs(2, cfg)} ${longLivedBackoffMs(3, cfg)}`)
  tally.check('a count below one reads as the first', longLivedBackoffMs(0) === 0 && longLivedBackoffMs(-3) === 0)
}

tally.section('§2 the roster on fixture children: a death from outside is a crash-respawn row, never a killed row, and the first respawn comes at once')
{
  const daemonLog: string[] = []
  const realConsoleError = console.error
  console.error = ((...args: unknown[]): void => {
    daemonLog.push(args.map(a => (typeof a === 'string' ? a : String(a))).join(' '))
  }) as typeof console.error
  const realChildren = await import('../../src/daemon/headlessRun.ts')
  const { recordSpawn } = await import('../../src/utils/spawnLedger.ts')
  type FakeChild = EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: () => boolean }
  const spawnAt = new Map<string, number[]>()
  const fakeChild = (): FakeChild =>
    Object.assign(new EventEmitter(), {
      pid: 2_147_483_001,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    })
  const children = new Map<string, FakeChild[]>()
  mock.module('../../src/daemon/headlessRun.ts', () => ({
    ...realChildren,
    spawnStreamJsonChild: (spec: StreamJsonChildSpec) => {
      const child = fakeChild()
      const list = children.get(spec.agentId) ?? []
      list.push(child)
      children.set(spec.agentId, list)
      const stamps = spawnAt.get(spec.agentId) ?? []
      stamps.push(Date.now())
      spawnAt.set(spec.agentId, stamps)
      recordSpawn({ kind: 'long-lived', id: spec.agentId, cwd: spec.cwd ?? '', role: spec.role })
      return { child, argv: [], env: {} }
    },
  }))
  const { TaskRoster } = await import('../../src/daemon/roster.ts')
  const roster = new TaskRoster({ dir: world, breaker: {} as never, maxInflight: 4 })
  const specOf = (short: string): StreamJsonChildSpec => ({
    cwd: world,
    model: 'fixture-model',
    effort: 'high',
    appendSystemPrompt: '',
    role: 'MERCURY_CONCOURSE_WORKER',
    agentName: short,
    agentId: `${short}@fixture`,
    plainIdentity: true,
  })
  const latest = (short: string): FakeChild | undefined => {
    const list = children.get(`${short}@fixture`) ?? []
    return list[list.length - 1]
  }
  const dieFromOutside = async (short: string, code: number): Promise<{ closedAt: number; gapMs: number | null }> => {
    const child = latest(short)
    const before = (spawnAt.get(`${short}@fixture`) ?? []).length
    const closedAt = Date.now()
    child?.emit('exit', code, null)
    child?.emit('close', code, null)
    const came = await until(() => (spawnAt.get(`${short}@fixture`) ?? []).length > before, 4_000)
    const stamps = spawnAt.get(`${short}@fixture`) ?? []
    return { closedAt, gapMs: came ? stamps[before]! - closedAt : null }
  }
  const cfg = { backoffBaseMs: 400, backoffCapMs: 3_000, healthyResetMs: 60_000 }

  const a = roster.registerLongLived('seat-a', specOf('seat-a'), cfg)
  tally.check('the seat registered on its first fixture child', a.ok, JSON.stringify(a))
  const d1 = await dieFromOutside('seat-a', 143)
  tally.check(`red on the base: the first death (exit 143 from outside) respawns at once — within ${AT_ONCE_MS} ms (the base waits the base backoff, 400 ms here)`, d1.gapMs !== null && d1.gapMs <= AT_ONCE_MS, `gap ${String(d1.gapMs)} ms`)
  const rowsA1 = rowsOf('seat-a@fixture')
  tally.check("the ledger's exit row reads crash-respawn with code 143 and no signal — never killed", rowsA1.some(r => isExitRow(r) && r.outcome === 'crash-respawn' && r.code === 143 && r.signal === null) && !rowsA1.some(r => r.outcome === 'killed'), JSON.stringify(rowsA1.map(r => [r.event ?? 'spawn', r.outcome ?? '', r.code ?? ''])))
  const ledgerGap1 = gapAfterExit(rowsA1, 1)
  tally.check(`red on the base: the ledger itself shows the respawn row within ${AT_ONCE_MS} ms of the exit row`, ledgerGap1 !== null && ledgerGap1.gapMs <= AT_ONCE_MS, ledgerGap1 === null ? 'no respawn row after the exit row' : `${ledgerGap1.gapMs} ms`)
  tally.check('the daemon log names the death with its code and the first rung', daemonLog.some(l => l.includes('long-lived seat-a crashed (code=143 sig=null); respawn (1/5)')), daemonLog.filter(l => l.includes('seat-a')).join(' | ').slice(0, 300))
  await sleep(40)
  const d2 = await dieFromOutside('seat-a', 143)
  tally.check('a second death inside the window keeps the backoff: the second rung (800 ms here) is waited', d2.gapMs !== null && d2.gapMs >= 700 && d2.gapMs <= 3_000, `gap ${String(d2.gapMs)} ms`)
  await sleep(40)
  const d3 = await dieFromOutside('seat-a', 1)
  tally.check('a third death waits the third rung (1600 ms here)', d3.gapMs !== null && d3.gapMs >= 1_400 && d3.gapMs <= 4_000, `gap ${String(d3.gapMs)} ms`)
  const rowsA = rowsOf('seat-a@fixture')
  tally.check('every death is an exit row followed by a spawn row; no row ever reads killed', rowsA.filter(isExitRow).length === 3 && rowsA.filter(isSpawnRow).length === 4 && !rowsA.some(r => r.outcome === 'killed'), JSON.stringify(rowsA.map(r => [r.event ?? 'spawn', r.outcome ?? ''])))
  roster.expectExit('seat-a', true)

  const b = roster.registerLongLived('seat-b', specOf('seat-b'), { ...cfg, healthyResetMs: 1 })
  tally.check('a second seat registered with a one-millisecond healthy bar', b.ok, JSON.stringify(b))
  await sleep(20)
  const e1 = await dieFromOutside('seat-b', 143)
  await sleep(40)
  const e2 = await dieFromOutside('seat-b', 143)
  await sleep(40)
  const e3 = await dieFromOutside('seat-b', 143)
  tally.check(`red on the base: every death after healthy uptime is a first death — each respawns within ${AT_ONCE_MS} ms`, [e1, e2, e3].every(e => e.gapMs !== null && e.gapMs <= AT_ONCE_MS), `gaps ${[e1, e2, e3].map(e => String(e.gapMs)).join(' / ')} ms`)
  roster.expectExit('seat-b', true)

  const c = roster.registerLongLived('seat-c', specOf('seat-c'), cfg)
  tally.check('a third seat registered', c.ok, JSON.stringify(c))
  const cChild = latest('seat-c')
  const cSpawns = (spawnAt.get('seat-c@fixture') ?? []).length
  roster.kill('seat-c')
  cChild?.emit('exit', 143, null)
  cChild?.emit('close', 143, null)
  await sleep(1_200)
  const rowsC = rowsOf('seat-c@fixture')
  tally.check("the stop verb's kill is the one road to a killed row: the exit row reads killed and nothing respawns", rowsC.some(r => isExitRow(r) && r.outcome === 'killed' && r.code === 143) && (spawnAt.get('seat-c@fixture') ?? []).length === cSpawns, JSON.stringify(rowsC.map(r => [r.event ?? 'spawn', r.outcome ?? ''])))
  tally.check('the roster row of the killed seat settled killed', roster.list().find(e => e.short === 'seat-c')?.outcome === 'killed', JSON.stringify(roster.list().find(e => e.short === 'seat-c')))
  console.error = realConsoleError
}

tally.section("§3 the source: the daemon's interrupt verb delivers and never signals; the runner's interrupt aborts the request and never exits; killed rows come only from an intentional stop")
{
  const main = read('src', 'daemon', 'main.ts')
  const verbAt = main.indexOf("if (action === 'interrupt') {")
  const verbEnd = main.indexOf("if (action === 'stop-agent'", verbAt)
  const verb = verbAt !== -1 && verbEnd !== -1 ? main.slice(verbAt, verbEnd) : ''
  tally.check('the interrupt verb writes a control_request of subtype interrupt on the control channel', verb.includes('roster.control(') && verb.includes("subtype: 'interrupt'"), verb === '' ? 'the verb block was not found' : verb.slice(0, 200))
  tally.check('…and holds no kill and no timer (the incident runtime cut the runner a second after the second press here)', verb !== '' && !/\bkill\(/.test(verb) && !verb.includes('setTimeout('), verb.split('\n').filter(l => /kill\(|setTimeout\(/.test(l)).join(' | '))
  tally.check("the verb's second press is a re-delivery in its own receipt", verb.includes("'second interrupt'"))
  const roster = read('src', 'daemon', 'roster.ts')
  const lifeAt = roster.indexOf('private superviseChildLife(')
  const life = lifeAt !== -1 ? roster.slice(lifeAt, roster.indexOf('async dispatch(', lifeAt)) : ''
  const killedAt = life.indexOf("ledgerExit('killed')")
  const intentionalAt = life.indexOf('if (ll.intentionalStop) {')
  tally.check("the ledger's killed row is written once, under the intentional-stop arm, and that arm arms no respawn", killedAt !== -1 && intentionalAt !== -1 && intentionalAt < killedAt && life.indexOf("ledgerExit('killed')", killedAt + 1) === -1 && /if \(ll\.intentionalStop\) \{[\s\S]*?return\s*\}/.test(life) && !/if \(ll\.intentionalStop\) \{[\s\S]*?respawnTimer = setTimeout[\s\S]*?return\s*\}/.test(life.slice(intentionalAt, killedAt + 400)))
  tally.check("a death from outside rides the ladder's own delay: the crash arm arms the respawn with the decision's delayMs", life.includes("ledgerExit('crash-respawn')") && life.includes('setTimeout(() => this.spawnLongLived(short), decision.delayMs)'))
  const print = read('src', 'cli', 'print.ts')
  const caseAt = print.indexOf("case 'interrupt': {")
  const caseEnd = print.indexOf("case 'withdraw_send': {", caseAt)
  const handler = caseAt !== -1 && caseEnd !== -1 ? print.slice(caseAt, caseEnd) : ''
  tally.check("the runner's interrupt handler aborts the in-flight request and releases the driver's hold", handler.includes('inFlightAbort?.abort()') && handler.includes('driver.releaseHold()'), handler === '' ? 'the case block was not found' : '')
  tally.check('…and never ends the process: no shutdown, no exit, no end-session signal in the handler', handler !== '' && !handler.includes('gracefulShutdown(') && !handler.includes('process.exit(') && !handler.includes('EndSessionSignal'))
  const executor = read('src', 'services', 'tools', 'toolExecution.ts')
  tally.check('the executor races a tool call against the abort: a call that never answers is abandoned within the grace and settles with the interrupt result', executor.includes('const TOOL_ABORT_GRACE_MS = 750') && executor.includes('class ToolCallAbandonedError') && executor.includes('const abandoned = error instanceof ToolCallAbandonedError') && executor.includes('const isInterrupt = abandoned || isAbortError(error)') && /const cutText = cutByTurn \? turnCutResultText\([\s\S]{0,1500}if \(cutText !== undefined\) push\(interruptResultUpdate\(toolUseID, sourceUUID, cutText\)\)/.test(executor))
}

tally.section('§4 LIVE on the built bundle: a hosted session, an op in flight, the interrupt through the daemon, a line sent meanwhile, then a death from outside')
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first or pass --dist <bundle>; §1–§3 above still ran`)
  await removeWorld(world)
  tally.finish()
}
if (process.platform === 'win32') {
  console.log('  [SKIP] the live leg signals a POSIX process; §1–§3 above still ran')
  await removeWorld(world)
  tally.finish()
}
console.log(`  bundle under proof: ${DIST}`)
const work = join(world, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# fixture\n')
seedFirstRun(runHome, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const PROBE = 'esc probe: run the long command'
const MEANWHILE = 'esc probe: the line sent while the command ran'
const AFTER = 'esc probe: the line sent after the runner came back'
const carries = (texts: string[], line: string): boolean => texts.some(t => t.includes(line))
const script: Script = req => {
  if (carries(req.allTexts, AFTER)) return [{ type: 'text', text: 'the respawned runner answers' }]
  if (carries(req.allTexts, MEANWHILE)) return [{ type: 'text', text: 'the same runner took the line sent meanwhile' }]
  if (req.ask.includes(PROBE) && req.step === 0) return [{ type: 'tool_use', name: 'Bash', input: { command: 'sleep 40', description: 'a long command the operator will interrupt' } }]
  const last = req.results[req.results.length - 1]
  return [{ type: 'text', text: last === undefined ? 'nothing to do' : `the turn went on after: ${last.text.slice(0, 200)}` }]
}
const fixture = await startScriptedFixture(script)
const port = Number(new URL(fixture.base).port)
const daemonEnv: NodeJS.ProcessEnv = { ...childEnv(runHome, port), ANTHROPIC_API_KEY: FIXTURE_API_KEY, MERCURY_CACHE_CLOCK: '0', MERCURY_PARTY: '0' }
delete daemonEnv.MERCURY_WORKER_PARENT_PID
delete daemonEnv.MERCURY_DAEMON_OWNER_PID
delete daemonEnv.MERCURY_DAEMON_OWNER_FD
delete daemonEnv.MERCURY_CONCOURSE_WORKER
delete daemonEnv.MERCURY_DAEMON_SUCCESSOR_OF
const daemonLogPath = join(world, 'daemon.log')
const logFd = openSync(daemonLogPath, 'a')
const daemon = spawn(NODE, [DIST, 'daemon', 'run', work], { cwd: work, env: daemonEnv, stdio: ['ignore', logFd, logFd] })
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')

type Rec = { runnerId: string; sessionId: string; pid?: number; stoppedAt?: number; turnCutAt?: number; endedAt?: number; crash?: { at: number; reason: string; respawning: boolean } }
const recordsFile = join(daemonDir, 'concourse-workers.json')
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(recordsFile, 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const readFacts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const ping = async (): Promise<boolean> => (await daemonControlRpc({ op: 'ping' })).ok
const transcriptText = (sid: string): string => {
  const p = join(paths.getProjectDir(work), `${sid}.jsonl`)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const sawLine = (text: string, after = 0): boolean => fixture.requests.some(r => r.n > after && carries(r.allTexts, text))
const opResult = (sid: string): { body: string; at: number } | null => {
  const m = /"occurredAt":"([^"]+)"[^\n]*"kind":"tool-result","callId":"toolu_[^"]+","body":"((?:[^"\\]|\\.)*)"/.exec(transcriptText(sid))
  return m === null ? null : { body: m[2]!, at: ms(m[1]!) }
}
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
  } catch {
  }
  await until(async () => !alive(daemon.pid), 8_000)
  try {
    daemon.kill('SIGTERM')
  } catch {
  }
  await fixture.close()
  if (tally.failed() === 0) await removeWorld(world)
  else console.log(`  [forensics] world kept: ${world} (daemon.log and daemon/spawn-ledger.jsonl beside it)`)
}

try {
  tally.check('the scratch-home daemon serves', await until(ping, bound(60_000)), daemonLog().slice(-600))
  const reply = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'esc-probe', prompt: PROBE, workspaceDir: work, title: 'esc probe', model: 'claude-opus-5', effort: 'high', permissionMode: 'sovereign' } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  tally.check('the session dispatched onto a runner', reply.ok === true && typeof reply.sessionId === 'string', JSON.stringify(reply))
  const sid = reply.sessionId ?? ''
  await until(() => readRec(sid)?.pid !== undefined, bound(30_000))
  const rec0 = readRec(sid)
  const pid1 = rec0?.pid
  const runnerId = rec0?.runnerId ?? ''
  const ledgerId = `${runnerId}@concourse`
  tally.check('the runner is live', rec0 !== undefined && alive(pid1), JSON.stringify(rec0))
  tally.check('the runner opened its turn and was handed the long command', await until(() => fixture.requests.some(r => r.step === 0 && r.ask.includes(PROBE)), bound(60_000)), JSON.stringify(fixture.requests.map(r => [r.n, r.step, r.ask.slice(0, 40)])))
  tally.check('the command is running (its tool_use row stands on the transcript, no result yet)', await until(() => /"name":"Bash"/.test(transcriptText(sid)), bound(30_000)) && opResult(sid) === null, transcriptText(sid).slice(-400))
  await sleep(1_000)

  const requestsBefore = fixture.requests.length
  const meanwhile = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'esc-meanwhile', prompt: MEANWHILE, workspaceDir: work, targetSessionId: sid, title: 'esc probe', model: 'claude-opus-5', effort: 'high', permissionMode: 'sovereign' } as never)) as { ok?: boolean; state?: string; error?: string }
  tally.check('a line sent while the command ran was delivered into the same session (queued behind the turn)', meanwhile.ok === true, JSON.stringify(meanwhile))
  await sleep(300)
  tally.check('…and the running command was not disturbed by it (no result yet, no new model call)', opResult(sid) === null && fixture.requests.length === requestsBefore, `${fixture.requests.length - requestsBefore} new request(s)`)
  const interruptedAt = Date.now()
  const interrupt = (await daemonControlRpc({ op: 'sessionControl', action: 'interrupt', sessionId: sid, by: 'operator', clientOpId: 'esc-probe-press-1' } as never)) as { ok?: boolean; outcome?: string; detail?: string }
  tally.check("the interrupt verb applied ('interrupt <runner>')", interrupt.ok === true && interrupt.outcome === 'applied' && /^interrupt /.test(interrupt.detail ?? ''), JSON.stringify(interrupt))
  const ended = await until(() => opResult(sid) !== null, bound(8_000))
  const result = opResult(sid)
  const endedIn = result === null ? null : result.at - interruptedAt
  tally.check('the op ended on the interrupt: its tool result landed within the grace (2500 ms)', ended && endedIn !== null && endedIn <= 2_500, result === null ? `no result within 8 s; transcript tail: ${transcriptText(sid).slice(-300)}` : `${endedIn} ms`)
  tally.check("…carrying the interruption in its words (the op's own answer to the abort, or the operator's synthetic result)", result !== null && /interrupted by user/i.test(result.body), result?.body.slice(0, 200) ?? '')
  tally.check('…and the interruption row closed the turn', await until(() => transcriptText(sid).includes('[Request interrupted by user for tool use]'), bound(4_000)), transcriptText(sid).split('\n').filter(l => l.includes('interrupted')).join(' | ').slice(0, 300))
  console.log(`  the op settled ${String(endedIn)} ms after the interrupt`)
  const meanwhileTook = await until(() => sawLine(MEANWHILE, requestsBefore), bound(6_000))
  tally.check('the line sent meanwhile reached the same runner and the model saw it right after the interrupt', meanwhileTook, JSON.stringify(fixture.requests.map(r => [r.n, r.step, r.allTexts.filter(t => t.includes('esc probe')).map(t => t.slice(0, 32))])))
  const recAfter = readRec(sid)
  tally.check("the runner's pid is unchanged and alive — the interrupt never touched the process", recAfter?.pid === pid1 && alive(pid1), JSON.stringify({ before: pid1, after: recAfter?.pid, alive: alive(pid1) }))
  const rowsNow = rowsOf(ledgerId)
  tally.check('the spawn ledger holds one spawn row for the runner and no exit row, no killed row', rowsNow.filter(isSpawnRow).length === 1 && !rowsNow.some(isExitRow) && !rowsNow.some(r => r.outcome === 'killed'), JSON.stringify(rowsNow.map(r => [r.event ?? 'spawn', r.outcome ?? ''])))
  tally.check('the daemon logged no crash and no cut for the runner', !daemonLog().includes(`long-lived ${runnerId} crashed`) && !/hard stop:|cutting the runner/.test(daemonLog()), daemonLog().split('\n').filter(l => l.includes(runnerId) && /crash|cut/.test(l)).join(' | ').slice(0, 300))
  tally.check('the record carries no stop, cut or crash stamp', recAfter !== undefined && recAfter.stoppedAt === undefined && recAfter.turnCutAt === undefined && recAfter.crash === undefined && recAfter.endedAt === undefined, JSON.stringify(recAfter))
  tally.check('the meanwhile turn settled and the seat reads idle', await until(() => readFacts(sid)?.busy === false && sawLine(MEANWHILE, requestsBefore), bound(30_000)), JSON.stringify(readFacts(sid)?.busy))

  console.log('\n  a death from outside: SIGTERM to the runner (the incident\'s exit 143) — the respawn rule')
  if (pid1 !== undefined) process.kill(pid1, 'SIGTERM')
  tally.check('the runner exited', await until(() => !alive(pid1), bound(15_000)), `pid ${pid1} alive=${alive(pid1)}`)
  const respawned = await until(() => gapAfterExit(rowsOf(ledgerId), 1) !== null, bound(15_000))
  const gap = gapAfterExit(rowsOf(ledgerId), 1)
  tally.check("the ledger's exit row reads crash-respawn with code 143 — a death from outside is never a killed row", gap !== null && gap.exit.outcome === 'crash-respawn' && gap.exit.code === 143, JSON.stringify(gap?.exit ?? rowsOf(ledgerId)))
  tally.check(`red on the base: the respawn row follows the exit row within 700 ms (the base waits a second)`, respawned && gap !== null && gap.gapMs <= 700, gap === null ? 'no respawn row' : `${gap.gapMs} ms between ${gap.exit.ts} and ${gap.spawn.ts}`)
  const cameBack = await until(() => {
    const r = readRec(sid)
    return r?.pid !== undefined && r.pid !== pid1 && alive(r.pid)
  }, bound(15_000))
  const recBack = readRec(sid)
  tally.check('the record names a new live runner pid', cameBack, JSON.stringify({ before: pid1, after: recBack?.pid }))
  tally.check('the crash row says the runner resumed', recBack?.crash?.respawning === true && /exit 143/.test(recBack.crash.reason), JSON.stringify(recBack?.crash))
  tally.check('the daemon log names the death and the first rung', daemonLog().includes(`long-lived ${runnerId} crashed (code=143 sig=null); respawn (1/5)`), daemonLog().split('\n').filter(l => l.includes('crashed')).join(' | ').slice(0, 300))
  const after = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'esc-after', prompt: AFTER, workspaceDir: work, targetSessionId: sid, title: 'esc probe', model: 'claude-opus-5', effort: 'high', permissionMode: 'sovereign' } as never)) as { ok?: boolean; error?: string }
  tally.check('a line sent after the respawn delivers into the same session', after.ok === true, JSON.stringify(after))
  tally.check('…and the respawned runner answers it', await until(() => sawLine(AFTER), bound(60_000)), JSON.stringify(fixture.requests.map(r => [r.n, r.step, r.allTexts.filter(t => t.includes('esc probe')).map(t => t.slice(0, 32))])))
} finally {
  await cleanup()
}
tally.finish()
