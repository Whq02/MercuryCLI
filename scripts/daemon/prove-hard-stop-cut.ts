#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-hard-stop-cut.ts — the second esc is a HARD stop: a
//  runner that does not answer the interrupt is cut within about a second,
//  the seat's facts fall with it, and the session survives; a runner that
//  answers is never cut.
//
//  The road under proof is the daemon's own (main.ts, the interrupt verb
//  with hard:true): deliver the interrupt on the runner's control channel,
//  and if the seat's turn is still open a second later, SIGTERM the runner's
//  tree, then publish the seat's facts once the child is gone. A runner
//  that IGNORES the first abort is a real runner FROZEN (SIGSTOP) mid-
//  thinking phase — its stdin holds the interrupt unread, its turn stays
//  open — and thawed (SIGCONT) once the cut has been dispatched, so the
//  pending SIGTERM lands and the exit is observed. The laws:
//
//    H1  the hard verb answers applied ('hard stop <runner>')
//    H2  THE CUT: the daemon logs the cut no sooner than the one-second
//        grace and within a few seconds of the verb; the thawed runner
//        exits on the SIGTERM (pid dead, roster row killed)
//    H3  THE FACTS FALL: the seat's facts publish busy:false once the child
//        is gone (the exit fires no idle edge — the cut publishes them)
//    H4  THE SESSION SURVIVES: no stopped stamp, no crash stamp — a hard
//        stop cuts the turn, never the session
//    H5  THE CONTROL: a healthy runner mid-thinking phase answers the hard
//        interrupt at once (the stream drops, the interruption row lands)
//        and is never cut — its pid lives on, no cut is logged for it
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-hard-stop-cut.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
      /* not yet */
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

// ── the world ───────────────────────────────────────────────────────────────
const SCRATCH = mkdtempSync(join(tmpdir(), 'hardstop-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# hard stop fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

const LONG_THINK_ASK = 'think long please'
type Rec = { runnerId: string; sessionId: string; pid?: number; stoppedAt?: number; crash?: unknown; lastDeliveryAt?: number; lastTurnSettledAt?: number }
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }
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

// ── the fixture server (node — its http raises the response's close on a drop) ──
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

// ── the daemon ──────────────────────────────────────────────────────────────
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
      /* gone */
    }
  }
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* down */
  }
  for (const p of [daemon, fixture]) {
    try {
      p.kill('SIGTERM')
    } catch {
      /* gone */
    }
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

/** Dispatch a session onto the never-ending thinking phase and wait for
 *  its request to open on the loopback. */
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

console.log('hard stop — a runner that does not answer is cut within a second; one that answers is never cut')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))

  console.log('\nH1–H4 the frozen runner is cut, the facts fall, the session survives')
  const a = await openThinking('hardstop-a')
  const pidA = a.rec?.pid
  check('the runner is live and mid-turn', a.rec !== undefined && alive(pidA) && (a.rec.lastTurnSettledAt ?? 0) < (a.rec.lastDeliveryAt ?? 0), JSON.stringify(a.rec))
  // FREEZE: the runner ignores everything from here — its stdin holds the
  // interrupt unread, its turn stays open on the seat.
  if (pidA !== undefined) {
    process.kill(pidA, 'SIGSTOP')
    frozen.add(pidA)
  }
  const sentAt = Date.now()
  const reply = (await daemonControlRpc({ op: 'sessionControl', action: 'interrupt', sessionId: a.sid, by: 'operator', hard: true } as never)) as { ok?: boolean; outcome?: string; detail?: string }
  check("H1 the hard verb answered applied ('hard stop <runner>')", reply.ok === true && reply.outcome === 'applied' && /^hard stop /.test(reply.detail ?? ''), JSON.stringify(reply))
  const cutNeedle = `hard stop: ${a.rec?.runnerId ?? '?'} still holds its turn a second after the interrupt — cutting the runner`
  check('the runner still stands 700 ms in (the grace is a full second — a runner that might still answer is not cut early)', await sleep(700).then(() => !daemonLog().includes(cutNeedle) && alive(pidA)))
  const cutSeen = await untilAsync(() => daemonLog().includes(cutNeedle), 4_000)
  const cutAt = Date.now()
  check('H2 the daemon cut the runner (the log names it) within a few seconds of the verb', cutSeen && cutAt - sentAt <= 4_000, `${cutAt - sentAt} ms · ${daemonLog().split('\n').filter(l => l.includes('hard stop')).join(' | ')}`)
  // THAW: the pending SIGTERM lands now.
  if (pidA !== undefined) {
    process.kill(pidA, 'SIGCONT')
    frozen.delete(pidA)
  }
  const died = await untilAsync(() => !alive(pidA), 6_000)
  check('H2 the thawed runner exits on the SIGTERM (pid dead)', died, `pid ${pidA} alive=${alive(pidA)}`)
  const listed = (await daemonControlRpc({ op: 'list' } as never)) as { jobs?: Array<{ short: string; outcome?: string }> }
  const row = listed.jobs?.find(j => j.short === a.rec?.runnerId)
  check('H2 the roster lists the runner killed', row === undefined || row.outcome === 'killed', JSON.stringify(row ?? null))
  const factsFell = await untilAsync(() => readFacts(a.sid)?.busy === false, 8_000)
  check('H3 the seat facts published busy:false once the child was gone', factsFell, JSON.stringify(readFacts(a.sid) ?? null))
  const after = readRec(a.sid)
  check('H4 the session survives: no stopped stamp, no crash stamp (a hard stop cuts the turn, never the session)', after !== undefined && after.stoppedAt === undefined && after.crash === undefined, JSON.stringify(after))

  console.log('\nH5 the control — a runner that answers is never cut')
  const b = await openThinking('hardstop-b')
  const pidB = b.rec?.pid
  const closedBefore = wire().filter(c => c.kind === 'anthropic-closed').length
  const replyB = (await daemonControlRpc({ op: 'sessionControl', action: 'interrupt', sessionId: b.sid, by: 'operator', hard: true } as never)) as { ok?: boolean; outcome?: string }
  check('the hard verb applied to the healthy runner', replyB.ok === true && replyB.outcome === 'applied', JSON.stringify(replyB))
  check('the stream dropped at once (the runner answered the interrupt)', await untilAsync(() => wire().filter(c => c.kind === 'anthropic-closed').length > closedBefore, 3_000))
  await sleep(2_000)
  const cutNeedleB = `hard stop: ${b.rec?.runnerId ?? '?'} still holds`
  check('two seconds on, the healthy runner lives and no cut was logged for it', alive(pidB) && !daemonLog().includes(cutNeedleB), `pid ${pidB} alive=${alive(pidB)}`)
  const transcript = join(paths.getProjectDir(work), `${b.sid}.jsonl`)
  check('its transcript carries the interruption row', existsSync(transcript) && readFileSync(transcript, 'utf8').includes('Request interrupted by user'), transcript)
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ HARD STOP CUT — the unanswering runner is cut in a second, the facts fall, the session survives; the answering runner is never cut' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
