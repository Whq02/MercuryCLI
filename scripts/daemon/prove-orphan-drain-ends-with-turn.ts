#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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

const PROBE = 'drain-probe:'
const PARK_BOUND_MS = 6_000
const LEAVE_BOUND_MS = 20_000
const DRAIN_CEILING_MINUTES = '2'

const SCRATCH = mkdtempSync(join(tmpdir(), 'orphan-drain-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# orphan drain fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const sup = await import('../../src/daemon/concourseWorkers.ts')

type Rec = { runnerId: string; sessionId: string; pid?: number; parkedAt?: number; parkedBy?: string; parkReason?: string; parkRequestedAt?: number; lastDeliveryAt?: number; lastTurnSettledAt?: number; endedAt?: number }
const recordsFile = join(daemonDir, 'concourse-workers.json')
const readRec = (sid: string): Rec | undefined => {
  try {
    const all = JSON.parse(readFileSync(recordsFile, 'utf8')) as { workers: Record<string, Rec> }
    return Object.values(all.workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const daemonLogPath = join(SCRATCH, 'daemon.log')
const daemonLog = (): string => (existsSync(daemonLogPath) ? readFileSync(daemonLogPath, 'utf8') : '')
const logTail = (): string => daemonLog().split('\n').filter(l => /park|owner|screen|idle|drain|shutting/.test(l)).slice(-8).join(' | ')

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const usage = { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(b => ((b as { type?: string; text?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : '')).join('')
      : ''
let seatStreams = 0
let seatStreamsEnded = 0
let releaseSeat: () => void = () => {}
const released = new Promise<void>(resolve => {
  releaseSeat = resolve
})
const fixture = createServer((req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = []
  req.on('data', c => chunks.push(c as Buffer))
  req.on('end', () => {
    const url = (req.url ?? '').split('?')[0] ?? ''
    if (req.method !== 'POST' || !url.endsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    let body: { model?: unknown; stream?: unknown; messages?: unknown[] } = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body
    } catch {}
    const model = typeof body.model === 'string' ? body.model : 'fixture'
    const seat = (body.messages ?? []).some(m => (m as { role?: string }).role === 'user' && textOf((m as { content?: unknown }).content).includes(PROBE))
    if (body.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_side', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(sse('message_start', { type: 'message_start', message: { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } }))
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: seat ? `${PROBE} working` : 'ok' } }))
    const finish = (): void => {
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }))
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage }))
      res.end(sse('message_stop', { type: 'message_stop' }))
    }
    if (!seat) {
      finish()
      return
    }
    seatStreams++
    void released.then(() => {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' — done' } }))
      finish()
      seatStreamsEnded++
    })
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const owner = spawn('sleep', ['900'], { stdio: 'ignore' })
const daemonEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_DAEMON_OWNER_PID: String(owner.pid),
  MERCURY_SESSION_PARK_DRAIN_MINUTES: DRAIN_CEILING_MINUTES,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: base,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
}
delete daemonEnv.MERCURY_DAEMON_PERSIST
delete daemonEnv.MERCURY_DAEMON_OWNER_FD
const logFd = openSync(daemonLogPath, 'a')
const daemon = spawn('node', [DIST, 'daemon', 'run', work], { cwd: work, env: daemonEnv as NodeJS.ProcessEnv, stdio: ['ignore', logFd, logFd] })
const daemonGone = (): boolean => daemon.exitCode !== null || daemon.signalCode !== null
const cleanup = async (): Promise<void> => {
  releaseSeat()
  try {
    owner.kill('SIGKILL')
  } catch {}
  if (!daemonGone()) {
    try {
      await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
    } catch {}
    try {
      daemon.kill('SIGTERM')
    } catch {}
    await untilAsync(daemonGone, 10_000)
  }
  fixture.closeAllConnections()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log("an orphaned daemon leaves when its last turn ends: a park asked for while a turn runs completes at that turn's own end, never at the drain ceiling")
try {
  check('the daemon serves under an owner', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' })).ok, 60_000))
  const dispatched = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'orphan-drain',
    prompt: `${PROBE} answer when the stream ends`,
    workspaceDir: work,
    title: 'Drain probe',
    model: 'claude-opus-5',
    effort: 'high',
  } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
  check('a session dispatched onto a real runner', dispatched.ok === true && typeof dispatched.sessionId === 'string', JSON.stringify(dispatched))
  const sid = dispatched.sessionId ?? ''
  check('its turn is in flight (the reply stream is open and held by the fixture)', await untilAsync(() => seatStreams >= 1, 90_000), `seat streams ${seatStreams}`)
  await sleep(400)
  const before = readRec(sid)
  const pid = before?.pid
  check('the record is live and mid-turn, no park asked for yet', before !== undefined && alive(pid) && sup.turnInFlightOf(before as never) && before.parkRequestedAt === undefined && before.parkedAt === undefined, JSON.stringify(before))

  owner.kill('SIGKILL')
  check('the daemon notices its owner is gone and asks every session to park: the one mid-turn drains', await untilAsync(() => /the screen is gone — parking every active session: parked 0, draining 1 /.test(daemonLog()), 45_000), logTail())
  const draining = readRec(sid)
  check('the park is asked for, not applied: the runner finishes its own turn and the daemon waits for it', draining?.parkRequestedAt !== undefined && draining.parkedAt === undefined && alive(pid) && !daemonGone(), JSON.stringify(draining))

  releaseSeat()
  check('the turn ends on the wire and in the record', await untilAsync(() => {
    const r = readRec(sid)
    return seatStreamsEnded >= 1 && r !== undefined && !sup.turnInFlightOf(r as never)
  }, 30_000), JSON.stringify(readRec(sid)))
  const settledAt = Date.now()
  const parkedInTime = await untilAsync(() => readRec(sid)?.parkedAt !== undefined, PARK_BOUND_MS)
  const parked = readRec(sid)
  check(`the session parks at its turn's end, within ${PARK_BOUND_MS / 1000} s (red on the base: the request still stands and the daemon waits for the ceiling)`, parkedInTime && parked?.parkRequestedAt === undefined, JSON.stringify(parked))
  check('…parked as asked, not as a turn cut at the drain ceiling', parked?.parkedAt !== undefined && parked.parkReason !== sup.PARK_DRAIN_CUT_REASON, String(parked?.parkReason))
  check('the runner is gone', await untilAsync(() => !alive(pid), 10_000), `pid ${pid} alive=${alive(pid)}`)
  const left = await untilAsync(daemonGone, Math.max(1_000, LEAVE_BOUND_MS - (Date.now() - settledAt)))
  check(`the daemon leaves with its last turn, within ${LEAVE_BOUND_MS / 1000} s of the turn's end and far inside the ${DRAIN_CEILING_MINUTES}-minute ceiling`, left, `still up ${Math.round((Date.now() - settledAt) / 1000)} s after the turn ended · ${logTail()}`)
  check('the daemon log tells it that way: the turn finished and the session parked, and nothing was cut', /finished its turn and parked \(a park was requested while it worked\)/.test(daemonLog()) && !/drain ceiling/.test(daemonLog()), logTail())
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nprove-orphan-drain-ends-with-turn: all green' : `\nprove-orphan-drain-ends-with-turn: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
