#!/usr/bin/env bun
// ============================================================================
//  scripts/daemon/prove-stop-acknowledged.ts — a session record reads
//  "stopped" ONLY when its runner is gone, and the stop reaches the runner's
//  turn before the record says so.
//
//  The operator's screen: the board painted "STOPPED · nothing listens ·
//  0 live" while the transcript kept receiving the turn's output and the
//  crew agents ran on — the stop verb stamped the record at the kill's
//  DISPATCH (the roster's kill is fire-and-forget and observes nothing), so
//  the record's truth was never the runner's. The laws under proof, on the
//  REAL daemon and a real runner (the switch fixture server under node
//  streams a thinking phase that never ends on its own):
//
//    S1  the stop is applied as a REQUEST on a live runner: right after the
//        verb answers, the record carries stopRequestedAt and says stopped
//        only if the runner is already gone — never over a live pid
//    S2  the runner's turn ends FIRST: the fixture sees the stream drop
//        (the hard interrupt on the runner's own control channel) no later
//        than the moment the record says stopped, and the transcript
//        carries the interruption row
//    S3  the acknowledgement: stoppedAt lands only once the runner's exit is
//        observed — at that read the pid is dead, and the roster lists the
//        runner as killed (no live seat)
//    S4  one set of facts: the snapshot's state ladder reads the pre-ack
//        record as working (a stop on its way is still a running session)
//        and the acknowledged record as stopped — the row and the live count
//        derive from the same stamp
//
//  Run: ~/.bun/bin/bun run scripts/daemon/prove-stop-acknowledged.ts
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
    await sleep(150)
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
const SCRATCH = mkdtempSync(join(tmpdir(), 'stopack-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# stop acknowledgement fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { concourseRecordState } = await import('../../src/services/concourse/concourseSnapshot.ts')

// Contract data shared with switch-fixture-server.ts (the ask that opens
// the never-ending thinking phase).
const LONG_THINK_ASK = 'think long please'

type Rec = {
  runnerId: string
  sessionId: string
  pid?: number
  procStart?: string
  lastDeliveryAt?: number
  lastTurnSettledAt?: number
  stoppedAt?: number
  stoppedBy?: string
  stopRequestedAt?: number
  stopRequestedBy?: string
  crash?: unknown
  parkedAt?: number
  attachedAt?: number
  pausedAt?: number
}
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(join(daemonDir, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid)
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
const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
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

const cleanup = async (): Promise<void> => {
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {
    /* down */
  }
  try {
    daemon.kill('SIGTERM')
  } catch {
    /* gone */
  }
  try {
    fixture.kill('SIGTERM')
  } catch {
    /* gone */
  }
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log('stop acknowledgement — the record says stopped only when the runner is gone')
try {
  check('the daemon serves', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const dispatched = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'stopack-1',
    prompt: LONG_THINK_ASK,
    workspaceDir: work,
    title: 'Long think',
    modelKey: 'claude-opus-5',
    effort: 'high',
  } as never)) as { ok?: boolean; sessionId?: string; error?: string }
  check('the session dispatched onto a real runner', dispatched.ok === true && typeof dispatched.sessionId === 'string', JSON.stringify(dispatched))
  const sid = dispatched.sessionId ?? ''
  check('the runner opened the never-ending thinking phase on the loopback', await untilAsync(() => wire().some(c => c.kind === 'anthropic-open'), 60_000), JSON.stringify(wire().map(c => c.kind)))
  const before = readRec(sid)
  check('the record is live and mid-turn before the stop (a delivery, no settle, a live pid)', before !== undefined && before.lastDeliveryAt !== undefined && (before.lastTurnSettledAt ?? 0) < (before.lastDeliveryAt ?? 0) && alive(before.pid), JSON.stringify(before))

  console.log('\nS1 the stop is applied as a request on a live runner')
  const stopAt = Date.now()
  const reply = (await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId: sid, by: 'operator' } as never)) as { ok?: boolean; outcome?: string; detail?: string; error?: string }
  check("the verb answered applied with the honest detail ('stop sent … reads stopped once it is gone')", reply.ok === true && reply.outcome === 'applied' && /stop sent/.test(reply.detail ?? ''), JSON.stringify(reply))
  const justAfter = readRec(sid)
  check('right after the verb the record carries the stop REQUEST', justAfter?.stopRequestedAt !== undefined || justAfter?.stoppedAt !== undefined, JSON.stringify(justAfter))
  check('the record never says stopped over a live pid', justAfter !== undefined && (justAfter.stoppedAt === undefined || !alive(justAfter.pid)), JSON.stringify({ stoppedAt: justAfter?.stoppedAt, pid: justAfter?.pid, alive: alive(justAfter?.pid) }))

  console.log('\nS3 the acknowledgement lands with the runner\'s exit')
  const acked = await untilAsync(() => readRec(sid)?.stoppedAt !== undefined, 15_000)
  const after = readRec(sid)
  const ackAlive = alive(after?.pid)
  check('stoppedAt landed (the runner\'s exit acknowledged the stop)', acked && after?.stoppedAt !== undefined, JSON.stringify(after))
  check('at the acknowledgement the pid is dead — nothing listens in fact', acked && !ackAlive, JSON.stringify({ pid: after?.pid, alive: ackAlive }))
  check('the request stamps retired with the acknowledgement; the actor is the operator', after?.stopRequestedAt === undefined && after?.stoppedBy === 'operator', JSON.stringify(after))
  const listed = (await daemonControlRpc({ op: 'list' } as never)) as { ok?: boolean; jobs?: Array<{ short: string; outcome?: string; busy?: boolean }> }
  const row = listed.jobs?.find(j => j.short === after?.runnerId)
  check('the roster lists the runner as killed — no live seat', row === undefined || (row.outcome === 'killed' && row.busy !== true), JSON.stringify(row ?? null))

  console.log('\nS2 the runner\'s turn ended first')
  const closed = wire().find(c => c.kind === 'anthropic-closed')
  check('the fixture saw the stream drop (the client aborted it)', closed !== undefined && closed.why === 'client-dropped', JSON.stringify(closed ?? null))
  check('the drop landed no later than the record said stopped', closed !== undefined && after?.stoppedAt !== undefined && closed.at <= after.stoppedAt, JSON.stringify({ closed: closed?.at, stoppedAt: after?.stoppedAt, stopAt }))
  const transcript = join(paths.getProjectDir(work), `${sid}.jsonl`)
  const rows = existsSync(transcript) ? readFileSync(transcript, 'utf8') : ''
  check('the transcript carries the interruption row (the hard interrupt reached the runner before the kill)', rows.includes('Request interrupted by user'), transcript)

  console.log('\nS5 the board speaks the verb\'s truth (structural)')
  {
    const route = readFileSync(join(REPO, 'src', 'components', 'concourse', 'ConcourseRoute.tsx'), 'utf8')
    check("the route's stop note paints the verb's detail for a stop on its way, and the removal hint only for an acknowledged stop", /const acknowledged = reply\.ok === true && reply\.outcome === 'applied' && \/\^stopped \/\.test\(reply\.detail \?\? ''\)/.test(route) && /acknowledged \|\| reply\.outcome === 'noop' \|\| reply\.detail === undefined \? `stopped — \$\{keyHintLabel\('⌃x ⌃x'\)\} removes it from the board` : reply\.detail/.test(route))
    check('the no-daemon arm speaks the same law from the verb\'s acknowledged flag', /out\.outcome === 'applied' && !out\.acknowledged\s*\n\s*\? \{ state: 'applied', reason: `stop sent — \$\{out\.runnerId\} ends its turn; the row reads stopped once it is gone` \}/.test(route))
    const screen = readFileSync(join(REPO, 'src', 'components', 'concourse', 'ConcourseScreen.tsx'), 'utf8')
    check("the close chord removes a row only when it reads stopped; a staged press over a live runner re-sends the stop and says where it stands", /if \(sel\.state === 'stopped'\) \{[\s\S]{0,500}callbacks\.removeSession\?\.\(sel\.sessionId\)/.test(screen) && /if \(staged\) \{[\s\S]{0,800}stop is on its way — the row reads stopped once its runner is gone[\s\S]{0,300}callbacks\.stopSession\?\.\(sel\.sessionId\)/.test(screen) && !/if \(staged \|\| sel\.state === 'stopped'\)/.test(screen))
  }

  console.log('\nS4 the row and the live count read one set of facts')
  if (justAfter !== undefined && after !== undefined) {
    const preAck = { ...justAfter, stoppedAt: undefined as number | undefined }
    delete preAck.stoppedAt
    const pre = concourseRecordState(preAck as never, { needsYou: false, alive: true })
    const post = concourseRecordState(after as never, { needsYou: false, alive: false })
    check("the ladder reads a stop on its way over a live runner as 'working' (still a live session, still counted)", pre === 'working', pre)
    check("the ladder reads the acknowledged record as 'stopped' (the same stamp the count drops)", post === 'stopped', post)
  } else {
    check('the ladder could be read on both records', false)
  }
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\n ✅ STOP ACKNOWLEDGED — the record says stopped only when the runner is gone' : `\n ❌ ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
