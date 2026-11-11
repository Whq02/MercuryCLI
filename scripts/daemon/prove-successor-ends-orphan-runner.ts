#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, type ChildProcess } from 'node:child_process'
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

const PROBE = 'orphan-probe:'
const AFTER = `${PROBE} and this, said to the daemon that came after`
const ENDED_BOUND_MS = 2_500

const SCRATCH = mkdtempSync(join(tmpdir(), 'orphan-runner-'))
const configDir = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [configDir, daemonDir, work]) mkdirSync(d, { recursive: true })
writeFileSync(join(work, 'README.md'), '# orphan runner fixture\n')
process.env.MERCURY_CONFIG_DIR = configDir
process.env.MERCURY_DAEMON_DIR = daemonDir
delete process.env.MERCURY_HOME
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(configDir, [work])
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')

type Rec = { runnerId: string; sessionId: string; pid?: number; parkedAt?: number; stoppedAt?: number; lastDeliveryAt?: number; lastTurnSettledAt?: number; endedAt?: number }
const recordsFile = join(daemonDir, 'concourse-workers.json')
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(readFileSync(recordsFile, 'utf8')) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const readRec = (sid: string): Rec | undefined => records().find(w => w.sessionId === sid)
const daemonState = (): { pid?: number } => {
  try {
    return JSON.parse(readFileSync(join(daemonDir, 'daemon.json'), 'utf8')) as { pid?: number }
  } catch {
    return {}
  }
}

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
const gates: Array<{ open: () => void; opened: Promise<void> }> = []
const gate = (nth: number): { open: () => void; opened: Promise<void> } => {
  while (gates.length < nth) {
    let open: () => void = () => {}
    const opened = new Promise<void>(resolve => {
      open = resolve
    })
    gates.push({ open, opened })
  }
  return gates[nth - 1]!
}
const releaseSeat = (nth: number): void => gate(nth).open()
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
    void gate(seatStreams).opened.then(() => {
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' — done' } }))
      finish()
      seatStreamsEnded++
    })
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const daemonEnv: Record<string, string | undefined> = {
  ...process.env,
  MERCURY_CONFIG_DIR: configDir,
  MERCURY_DAEMON_DIR: daemonDir,
  MERCURY_DAEMON_PERSIST: '1',
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: base,
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
}
delete daemonEnv.MERCURY_DAEMON_OWNER_PID
delete daemonEnv.MERCURY_DAEMON_OWNER_FD
const daemons: Array<{ child: ChildProcess; log: string }> = []
const gone = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null
const boot = async (name: string): Promise<{ child: ChildProcess; log: () => string } | null> => {
  const logPath = join(SCRATCH, `${name}.log`)
  const logFd = openSync(logPath, 'a')
  const child = spawn('node', [DIST, 'daemon', 'run', work], { cwd: work, env: daemonEnv as NodeJS.ProcessEnv, stdio: ['ignore', logFd, logFd] })
  daemons.push({ child, log: logPath })
  const serving = await untilAsync(async () => daemonState().pid === child.pid && (await daemonControlRpc({ op: 'ping' })).ok, 60_000)
  return serving ? { child, log: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '') } : null
}
const seen = new Set<number>()
const cleanup = async (): Promise<void> => {
  for (let nth = 1; nth <= 4; nth++) releaseSeat(nth)
  try {
    await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never)
  } catch {}
  for (const d of daemons) {
    if (gone(d.child)) continue
    try {
      d.child.kill('SIGTERM')
    } catch {}
    await untilAsync(() => gone(d.child), 10_000)
  }
  for (const pid of seen) {
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  fixture.closeAllConnections()
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log("a daemon that dies while a session works leaves its runner without a host: the daemon that comes after ends that runner as it starts, and the session answers the next message")
try {
  const first = await boot('daemon-first')
  check('the first daemon serves', first !== null)
  const dispatched = (await daemonControlRpc({
    op: 'concourseDispatch',
    clientMessageId: 'orphan-runner',
    prompt: `${PROBE} answer when the stream ends`,
    workspaceDir: work,
    title: 'Orphan probe',
    model: 'claude-opus-5',
    effort: 'high',
  } as never, { timeoutMs: 15_000 })) as { ok?: boolean; sessionId?: string }
  check('a session dispatched onto a real runner', dispatched.ok === true && typeof dispatched.sessionId === 'string', JSON.stringify(dispatched))
  const sid = dispatched.sessionId ?? ''
  check('its turn is in flight (the reply stream is open and held by the fixture)', await untilAsync(() => seatStreams >= 1, 90_000), `seat streams ${seatStreams}`)
  await sleep(400)
  const before = readRec(sid)
  const orphan = before?.pid
  if (orphan !== undefined) seen.add(orphan)
  check('the record names a live runner mid-turn', orphan !== undefined && alive(orphan) && (before?.lastDeliveryAt ?? 0) > (before?.lastTurnSettledAt ?? 0), JSON.stringify(before))

  first?.child.kill('SIGKILL')
  check('the daemon is killed outright and its runner outlives it: the scene is staged', (await untilAsync(() => first !== null && gone(first.child), 10_000)) && alive(orphan), `runner alive=${alive(orphan)}`)

  const second = await boot('daemon-second')
  const servedAt = Date.now()
  check('a second daemon takes the same home and serves', second !== null)
  const endedInTime = await untilAsync(() => !alive(orphan), ENDED_BOUND_MS)
  check(`the runner the dead daemon left is gone within ${ENDED_BOUND_MS / 1000} s of the second daemon serving (red on the base: it lives on with no host until its own watch ends it)`, endedInTime, `pid ${orphan} alive ${Date.now() - servedAt} ms after the second daemon served`)
  check('the second daemon says what it did', /left by a daemon that died/.test(second?.log() ?? ''), (second?.log() ?? '').split('\n').slice(-6).join(' | '))
  const held = readRec(sid)
  check('the session is neither parked, stopped nor ended by it: its record waits for its next message', held !== undefined && held.parkedAt === undefined && held.stoppedAt === undefined && held.endedAt === undefined, JSON.stringify(held))

  const said = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'orphan-runner-after', prompt: AFTER, workspaceDir: '', targetSessionId: sid, by: 'operator' } as never, { timeoutMs: 30_000 })) as { ok?: boolean; state?: string; error?: string }
  check("the operator's next message is taken (red on the base: instruction delivery failed, the message lost)", said.ok === true, JSON.stringify(said))
  check('a fresh runner serves the session and asks the model with it', await untilAsync(() => seatStreams >= 2, 60_000), `seat streams ${seatStreams}`)
  const revived = readRec(sid)
  if (revived?.pid !== undefined) seen.add(revived.pid)
  check('…a new process, not the one that was left', revived?.pid !== undefined && revived.pid !== orphan && alive(revived.pid), JSON.stringify({ orphan, now: revived?.pid }))
  releaseSeat(2)
  check('its reply ends and the turn settles on the record', (await untilAsync(() => seatStreamsEnded >= 1, 30_000)) && (await untilAsync(() => {
    const r = readRec(sid)
    return r !== undefined && (r.lastTurnSettledAt ?? 0) >= (r.lastDeliveryAt ?? 1)
  }, 30_000)), JSON.stringify(readRec(sid)))
  const down = (await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 15_000 }).catch(() => null)) as { ok?: boolean } | null
  check('the second daemon shuts down and no runner of this home is left alive', down?.ok === true && (await untilAsync(() => second !== null && gone(second.child), 20_000)) && (await untilAsync(() => [...seen].every(pid => !alive(pid)), 10_000)), JSON.stringify([...seen].map(pid => [pid, alive(pid)])))
} finally {
  await cleanup()
}

console.log(failures === 0 ? '\nprove-successor-ends-orphan-runner: all green' : `\nprove-successor-ends-orphan-runner: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
