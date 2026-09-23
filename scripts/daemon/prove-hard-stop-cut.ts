#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('✗ dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('prove-hard-stop-cut: SIGSTOP/SIGCONT are POSIX — nothing to drive on win32')
  process.exit(0)
}
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {
    }
    await sleep(100)
  }
  return false
}
const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'hardstop-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# second esc fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const sup = await import('../../src/daemon/concourseSupervisor.ts')

const LONG_THINK_ASK = 'think long please'
type Rec = { runnerId: string; sessionId: string; pid?: number; stoppedAt?: number; stoppedBy?: string; stopRequestedAt?: number; crash?: { at: number; reason: string; respawning: boolean }; turnCutAt?: number; turnCutBy?: string; lastDeliveryAt?: number; lastTurnSettledAt?: number }
type Workers = { workers: Record<string, Rec> }
const recordsFile = join(daemonDir, 'concourse-workers.json')
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(recordsFile, 'utf8')) as Workers
    return Object.values(all.workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const readFacts = (sid: string): { busy?: boolean; atMs?: number } | undefined => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'session-facts', `${sid}.json`), 'utf8')) as { busy?: boolean; atMs?: number }
  } catch {
    return undefined
  }
}
type Capture = { kind: string; at: number; why?: string }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')
const noStamps = (rec: Rec | undefined): boolean => rec !== undefined && rec.turnCutAt === undefined && rec.stoppedAt === undefined && rec.stopRequestedAt === undefined && rec.crash === undefined
type RosterRow = { short: string; outcome?: string; state?: string }
const rosterRow = async (short: string | undefined): Promise<RosterRow | undefined> => {
  const listed = (await daemonControlRpc({ op: 'list' } as never)) as { jobs?: RosterRow[] }
  return listed.jobs?.find(j => j.short === short)
}

const fixture = spawn('node', [join(REPO, 'scripts', 'journey', 'switch-fixture-server.ts'), captureFile], { stdio: ['ignore', 'pipe', 'pipe'] })
const port = await new Promise<number>((resolve, reject) => {
  const killer = setTimeout(() => reject(new Error('fixture server never printed PORT')), 15_000)
  let buffer = ''
  fixture.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const m = /PORT (\d+)/.exec(buffer)
    if (m) {
      clearTimeout(killer)
      resolve(Number(m[1]))
    }
  })
  fixture.on('exit', code => reject(new Error(`fixture server exited early (${code})`)))
}).catch(err => {
  console.log(`FAIL ${String(err)}`)
  process.exit(1)
})
const base = `http://127.0.0.1:${port}`

const logFd = openSync(daemonLogPath, 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: base,
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const frozen = new Set<number>()
const cleanup = async (): Promise<void> => {
  for (const pid of frozen) {
    try {
      process.kill(pid, 'SIGCONT')
    } catch {
    }
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
  }
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
    }
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

const openThinking = async (id: string): Promise<{ sid: string; rec: Rec | undefined }> => {
  const opensBefore = wire().filter(c => c.kind === 'anthropic-open').length
  const dispatched = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: id,
    prompt: LONG_THINK_ASK,
    workspaceDir: work,
    title: `Long think ${id}`,
    model: 'claude-opus-5',
    effort: 'high',
  } as never)) as { ok?: boolean; sessionId?: string }
  check(`${id}: the session dispatched onto a real runner`, dispatched.ok === true && typeof dispatched.sessionId === 'string', JSON.stringify(dispatched))
  const sid = dispatched.sessionId ?? ''
  check(`${id}: the runner opened the never-ending thinking phase`, await untilAsync(() => wire().filter(c => c.kind === 'anthropic-open').length > opensBefore, 60_000), JSON.stringify(wire().map(c => c.kind)))
  await sleep(400)
  return { sid, rec: readRec(sid) }
}
const interrupt = async (sid: string, hard: boolean, by = 'operator'): Promise<{ ok?: boolean; outcome?: string; detail?: string }> =>
  (await daemonControlRpc({ op: 'sessionControl', action: 'interrupt', sessionId: sid, by, ...(hard ? { hard: true } : {}) } as never)) as { ok?: boolean; outcome?: string; detail?: string }

console.log('the second esc — the interrupt goes again, the runner is never cut; the stop verb is the cut, recorded as a stop')
console.log(" red on the base: H2 (the frozen runner was cut a second after the second press), H4 (its record carried the cut stamp or, on the older base, nothing and then a crash), H6's reconcile (a stop-requested runner found dead read as crashed) and H6's reason ('relaunch', never 'stop')")
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  console.log('\nH1–H4 the frozen runner: two presses, no signal, then the answer')
  const a = await openThinking('secondesc-a')
  const pidA = a.rec?.pid
  check('the runner is live and mid-turn', a.rec !== undefined && alive(pidA) && (a.rec.lastTurnSettledAt ?? 0) < (a.rec.lastDeliveryAt ?? 0), JSON.stringify(a.rec))
  if (pidA !== undefined) {
    process.kill(pidA, 'SIGSTOP')
    frozen.add(pidA)
  }
  const first = await interrupt(a.sid, false)
  const second = await interrupt(a.sid, true)
  check("the first press answered applied ('interrupt <runner>')", first.ok === true && first.outcome === 'applied' && /^interrupt /.test(first.detail ?? ''), JSON.stringify(first))
  check("H1 the second press answered applied ('second interrupt <runner>') — a re-delivery, never a hard stop", second.ok === true && second.outcome === 'applied' && /^second interrupt /.test(second.detail ?? ''), JSON.stringify(second))
  await sleep(3_000)
  const rowFrozen = await rosterRow(a.rec?.runnerId)
  check('H2 three seconds on, the frozen runner lives: no signal was sent (red on the base: cut at one second)', alive(pidA), `pid ${pidA} alive=${alive(pidA)}`)
  check('H2 the daemon logged no cut', !/hard stop:|cutting the runner/.test(daemonLog()), daemonLog().split('\n').filter(l => /hard stop|cutting/.test(l)).join(' | '))
  check('H2 the roster row stays live (no outcome)', rowFrozen !== undefined && rowFrozen.outcome === undefined, JSON.stringify(rowFrozen ?? null))
  check('H2 the record carries no cut, stop or crash stamp while the runner holds its turn', noStamps(readRec(a.sid)), JSON.stringify(readRec(a.sid)))
  const closedBefore = wire().filter(c => c.kind === 'anthropic-closed').length
  if (pidA !== undefined) {
    process.kill(pidA, 'SIGCONT')
    frozen.delete(pidA)
  }
  check('H3 thawed, the runner reads the interrupts and drops its stream', await untilAsync(() => wire().filter(c => c.kind === 'anthropic-closed').length > closedBefore, 8_000), JSON.stringify(wire().map(c => c.kind)))
  const transcriptA = join(paths.getProjectDir(work), `${a.sid}.jsonl`)
  check('H3 its transcript carries the interruption row', await untilAsync(() => existsSync(transcriptA) && readFileSync(transcriptA, 'utf8').includes('Request interrupted by user'), 8_000), transcriptA)
  check("H3 the seat's facts read idle once the turn is answered", await untilAsync(() => readFacts(a.sid)?.busy === false, 8_000), JSON.stringify(readFacts(a.sid) ?? null))
  check('H3 the pid lives on — the same runner takes the next words', alive(pidA), `pid ${pidA} alive=${alive(pidA)}`)
  const afterA = readRec(a.sid)
  check('H4 the record carries no stamp of any kind after it all', noStamps(afterA), JSON.stringify(afterA))
  check("H4 a relaunch of this session would read 'relaunch' — never 'stop', never 'crash'", sup.runnerRestartReasonOf(afterA ?? {}) === 'relaunch', sup.runnerRestartReasonOf(afterA ?? {}))

  console.log('\nH5 the control — a healthy runner answers the second-press interrupt at once')
  const b = await openThinking('secondesc-b')
  const pidB = b.rec?.pid
  const closedBeforeB = wire().filter(c => c.kind === 'anthropic-closed').length
  const replyB = await interrupt(b.sid, true)
  check('the second-press verb applied to the healthy runner', replyB.ok === true && replyB.outcome === 'applied', JSON.stringify(replyB))
  check('the stream dropped at once (the runner answered the interrupt)', await untilAsync(() => wire().filter(c => c.kind === 'anthropic-closed').length > closedBeforeB, 3_000))
  await sleep(2_000)
  check('two seconds on, the healthy runner lives and nothing was logged as a cut', alive(pidB) && !/hard stop:|cutting the runner/.test(daemonLog()), `pid ${pidB} alive=${alive(pidB)}`)
  const transcriptB = join(paths.getProjectDir(work), `${b.sid}.jsonl`)
  check('its transcript carries the interruption row', existsSync(transcriptB) && readFileSync(transcriptB, 'utf8').includes('Request interrupted by user'), transcriptB)

  console.log('\nH6 the stop verb — the one cut, recorded as a stop; the reconcile never calls it a crash; the resume brings it back')
  const c = await openThinking('secondesc-c')
  const pidC = c.rec?.pid
  const runnerC = c.rec?.runnerId ?? '?'
  const stopAt = Date.now()
  const stopped = (await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId: c.sid, by: 'operator' } as never)) as { ok?: boolean; outcome?: string; detail?: string }
  const snapshot = JSON.parse(readFileSync(recordsFile, 'utf8')) as Workers
  check('H6 the stop verb applied to the live runner (the kill is dispatched, the exit acknowledges)', stopped.ok === true && stopped.outcome === 'applied', JSON.stringify(stopped))
  const requested = Object.values(snapshot.workers).find(w => w.sessionId === c.sid)
  check('H6 the stop request carries the cut stamp, by the operator (red on the base: no stamp)', requested !== undefined && requested.stopRequestedAt !== undefined && typeof requested.turnCutAt === 'number' && requested.turnCutAt >= stopAt && requested.turnCutBy === 'operator', JSON.stringify(requested))
  check('H6 the killed runner exits', await untilAsync(() => !alive(pidC), 10_000), `pid ${pidC} alive=${alive(pidC)}`)
  const windowDir = join(SCRATCH, 'reconcile-window')
  const bareDir = join(SCRATCH, 'reconcile-bare')
  for (const d of [windowDir, bareDir]) mkdirSync(d, { recursive: true })
  const windowShape = structuredClone(snapshot)
  for (const w of Object.values(windowShape.workers)) if (w.sessionId === c.sid) delete w.stoppedAt
  writeFileSync(join(windowDir, 'concourse-workers.json'), JSON.stringify(windowShape))
  const bareShape = structuredClone(windowShape)
  for (const w of Object.values(bareShape.workers)) {
    if (w.sessionId !== c.sid) continue
    delete w.turnCutAt
    delete w.turnCutBy
    delete w.stopRequestedAt
  }
  writeFileSync(join(bareDir, 'concourse-workers.json'), JSON.stringify(bareShape))
  const windowReceipt = sup.reconcileConcourseWorkers(new Set<string>(), windowDir)
  const windowAfter = (JSON.parse(readFileSync(join(windowDir, 'concourse-workers.json'), 'utf8')) as Workers).workers[runnerC]
  check('H6 the reconcile over the stop-requested record with its pid dead reads it stopped, never crashed (red on the base: CRASHED)', !windowReceipt.settled.includes(runnerC) && windowReceipt.live.includes(runnerC) && windowAfter?.crash === undefined && windowAfter?.stoppedAt !== undefined && windowAfter.stoppedBy === 'operator', JSON.stringify({ receipt: windowReceipt, after: windowAfter }))
  const bareReceipt = sup.reconcileConcourseWorkers(new Set<string>(), bareDir)
  check('H6 the same record with no stop request and no cut stamp is what the reconcile calls a crash — the stamps are what keep the stop honest', bareReceipt.settled.includes(runnerC), JSON.stringify(bareReceipt))
  check('H6 the real record acknowledges the stop at the exit: stoppedAt lands, the cut stamp stands, no crash', await untilAsync(() => {
    const rec = readRec(c.sid)
    return rec !== undefined && rec.stoppedAt !== undefined && rec.turnCutAt !== undefined && rec.crash === undefined && rec.stopRequestedAt === undefined
  }, 10_000), JSON.stringify(readRec(c.sid)))
  check("H6 a relaunch of the stopped session reads 'stop', never 'crash' (red on the base: 'relaunch')", sup.runnerRestartReasonOf(readRec(c.sid) ?? {}) === 'stop', sup.runnerRestartReasonOf(readRec(c.sid) ?? {}))
  const resumed = (await daemonControlRpc({ op: 'sessionControl', action: 'resume', sessionId: c.sid, by: 'operator' } as never)) as { ok?: boolean; outcome?: string; detail?: string }
  check('H6 the resume verb brings the stopped session back (revived)', resumed.ok === true && resumed.outcome === 'applied' && /revived/.test(resumed.detail ?? ''), JSON.stringify(resumed))
  const cameBack = await untilAsync(() => {
    const rec = readRec(c.sid)
    return rec?.pid !== undefined && rec.pid !== pidC && alive(rec.pid)
  }, 15_000)
  const backRec = readRec(c.sid)
  check('H6 the record names a new live runner pid', cameBack, JSON.stringify({ before: pidC, after: backRec?.pid }))
  check('H6 the revived record carries no cut stamp, no stop stamp and no crash stamp (the runner is back)', backRec !== undefined && backRec.turnCutAt === undefined && backRec.stoppedAt === undefined && backRec.crash === undefined, JSON.stringify(backRec))
  const ledger = existsSync(join(daemonDir, 'spawn-ledger.jsonl')) ? readFileSync(join(daemonDir, 'spawn-ledger.jsonl'), 'utf8') : ''
  const spawnRows = ledger.split('\n').filter(l => l.includes(`"${runnerC}@`) && !l.includes('"event":"exit"'))
  check('H6 the ledger holds the resume as a second spawn row of the same seat', spawnRows.length >= 2, `${spawnRows.length} spawn row(s)`)
  copyFileSync(recordsFile, join(SCRATCH, 'records-at-end.json'))
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ SECOND ESC — the interrupt goes again and the runner is never cut; the stop verb is the one cut, recorded as a stop' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
