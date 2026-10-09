#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
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
    } catch {}
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

const SCRATCH = mkdtempSync(join(tmpdir(), 'daemon-stop-parks-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
const folder = join(SCRATCH, 'work-stop')
for (const d of [configDir, daemonDir, work, folder]) mkdirSync(d, { recursive: true })
for (const d of [work, folder]) writeFileSync(join(d, 'README.md'), '# daemon stop fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work, folder])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')

type Rec = { runnerId: string; sessionId: string; pid?: number; parkedAt?: number; parkedBy?: string; parkReason?: string; parkRequestedAt?: number; stoppedAt?: number; crash?: { at: number; reason: string; respawning: boolean }; lastDeliveryAt?: number; lastTurnSettledAt?: number; endedAt?: number }
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
type Capture = { kind: string; at: number }
const captureFile = join(SCRATCH, 'wire-captures.jsonl')
writeFileSync(captureFile, '')
const wire = (): Capture[] =>
  readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => JSON.parse(l) as Capture)
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')

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

const logFd = openSync(daemonLogPath, 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    MERCURY_CONFIG_DIR: configDir,
    MERCURY_DAEMON_DIR: daemonDir,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
  },
  stdio: ['ignore', logFd, logFd],
})
const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {}
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {}
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log('mercury daemon stop parks the sessions it ends (RELEASE-29-AIR R29A-05b): the record carries the operator\'s mark, the next boot reads parked, never crashed')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const opensBefore = wire().filter(c => c.kind === 'anthropic-open').length
  const dispatched = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'stop-parks',
    prompt: 'think long please',
    workspaceDir: folder,
    title: 'Long think under a daemon stop',
    model: 'claude-opus-5',
    effort: 'high',
  } as never)) as { ok?: boolean; sessionId?: string }
  check('a session dispatched onto a real runner', dispatched.ok === true && typeof dispatched.sessionId === 'string', JSON.stringify(dispatched))
  const sid = dispatched.sessionId ?? ''
  check('its turn is in flight (the never-ending thinking phase opened on the wire)', await untilAsync(() => wire().filter(c => c.kind === 'anthropic-open').length > opensBefore, 60_000), JSON.stringify(wire().map(c => c.kind)))
  await sleep(400)
  const before = readRec(sid)
  const pid = before?.pid
  check('the record is live and mid-turn before the stop', before !== undefined && alive(pid) && sup.turnInFlightOf(before as never) && before.parkedAt === undefined && before.crash === undefined, JSON.stringify(before))

  const stopAt = Date.now()
  const reply = (await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)) as { ok?: boolean; op?: string; reaped?: number; workers?: Array<{ pid?: number }> }
  check("mercury daemon stop (the shutdown RPC with reapWorkers) is acknowledged and still counts the session's runner among the workers it reaped (the warm spare beside it)", reply.ok === true && reply.op === 'shutdown' && (reply.reaped ?? 0) >= 1 && (reply.workers ?? []).some(w => w.pid === pid), JSON.stringify(reply))
  check('the runner is gone', await untilAsync(() => !alive(pid), 15_000), `pid ${pid} alive=${alive(pid)}`)
  check('the daemon is gone', await untilAsync(() => daemon.exitCode !== null || daemon.signalCode !== null || !alive(daemon.pid), 15_000))
  const after = readRec(sid)
  check("the record carries the operator's mark: parked by the stop, at the stop, with its reason (red on the base: no mark of any kind)", after !== undefined && after.parkedAt !== undefined && after.parkedAt >= stopAt && after.parkedBy === 'daemon:stop' && after.parkReason === 'parked — the daemon was stopped' && after.crash === undefined && after.parkRequestedAt === undefined, JSON.stringify(after))
  check('the daemon log says what it did', /stop parks every active session: parked 1/.test(daemonLog()), daemonLog().split('\n').filter(l => /park/.test(l)).join(' | '))

  const nextBoot = join(SCRATCH, 'next-boot')
  const bare = join(SCRATCH, 'bare')
  for (const d of [nextBoot, bare]) mkdirSync(d, { recursive: true })
  const snapshot = JSON.parse(readFileSync(recordsFile, 'utf8')) as Workers
  writeFileSync(join(nextBoot, 'concourse-workers.json'), JSON.stringify(snapshot))
  const nextReceipt = sup.reconcileConcourseWorkers(new Set<string>(), nextBoot)
  const nextRec = Object.values((JSON.parse(readFileSync(join(nextBoot, 'concourse-workers.json'), 'utf8')) as Workers).workers).find(w => w.sessionId === sid)
  check("the next daemon's reconcile over the parked record with its pid dead settles nothing as crashed (red on the base: 'crashed — found dead with its daemon')", !nextReceipt.settled.includes(after?.runnerId ?? '?') && nextRec?.crash === undefined && nextRec?.parkedAt !== undefined, JSON.stringify({ receipt: nextReceipt, rec: nextRec }))
  check("a resume of the parked session reads 'relaunch', never 'crash' — no restart carry, no relaunched crewmate", sup.runnerRestartReasonOf((nextRec ?? {}) as never) === 'relaunch', sup.runnerRestartReasonOf((nextRec ?? {}) as never))

  const bareShape = structuredClone(snapshot)
  for (const w of Object.values(bareShape.workers)) {
    if (w.sessionId !== sid) continue
    delete w.parkedAt
    delete w.parkedBy
    delete w.parkReason
  }
  writeFileSync(join(bare, 'concourse-workers.json'), JSON.stringify(bareShape))
  const bareReceipt = sup.reconcileConcourseWorkers(new Set<string>(), bare)
  check("control: the same record with the stop's mark stripped is what the reconcile calls a crash — a daemon killed from outside still reads crash", bareReceipt.settled.includes(after?.runnerId ?? '?'), JSON.stringify(bareReceipt))

  const main = readFileSync(join(REPO, 'src/daemon/main.ts'), 'utf8')
  const stopArm = main.slice(main.indexOf('onShutdown: async (reapWorkers'), main.indexOf('const forwarded = forwardedFromPlane'))
  check('the stop parks before it reaps, and counts the workers it had before the park (structural)', /const live = roster\.liveWorkerFacts\(\)[\s\S]*parkAllConcourseSessions\('daemon:stop', roster, undefined, \{ reason: 'parked — the daemon was stopped', afterTurn: false \}\)[\s\S]*for \(const w of live\)/.test(stopArm), stopArm.slice(0, 600))
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nprove-daemon-stop-parks: all green' : `\nprove-daemon-stop-parks: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
