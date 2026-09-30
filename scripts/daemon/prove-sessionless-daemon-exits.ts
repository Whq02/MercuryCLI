#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const DIST = join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(DIST)) {
  console.error('dist/mercury.mjs missing — run `bun run build.ts` first')
  process.exit(1)
}
const KEEP = process.env.SESSIONLESS_KEEP === '1'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const untilAsync = async (pred: () => Promise<boolean> | boolean, ms: number, everyMs = 100): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true
    } catch {}
    await sleep(everyMs)
  }
  return false
}
const guard = setTimeout(() => {
  console.log('\n❌ TIMEOUT — prove-sessionless-daemon-exits exceeded 200s')
  process.exit(1)
}, 200_000)
guard.unref?.()

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sessionless-daemon-')))
const home = join(SCRATCH, 'home')
const daemonDir = join(SCRATCH, 'daemon')
const work = join(SCRATCH, 'work')
for (const d of [home, daemonDir, work]) mkdirSync(d, { recursive: true })
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = daemonDir
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const k of ['MERCURY_HOME', 'MERCURY_CREW_DIR', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_SUCCESSOR_OF', 'MERCURY_DAEMON_HANDOVER_FROM', 'NODE_ENV']) delete process.env[k]
const git = (args: string[]): void => {
  const r = spawnSync('git', ['-C', work, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}
git(['init', '-q'])
writeFileSync(join(work, 'README.md'), 'the sessionless probe repository\n')
git(['add', 'README.md'])
git(['commit', '-q', '-m', 'the probe commit'])
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(home, [work])
const { daemonControlRpc, controlSockPath, supervisorStatePath } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')
const { isProcessAlive } = await import('../../src/daemon/ownerWatch.ts')

const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`
let hits = 0
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
    hits++
    const text = 'sessionless-probe: answered'
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.end(
      [
        `event: message_start\n${sse({ type: 'message_start', message: { id: `msg_s_${hits}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } })}`,
        `event: content_block_start\n${sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}`,
        `event: content_block_delta\n${sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}`,
        `event: content_block_stop\n${sse({ type: 'content_block_stop', index: 0 })}`,
        `event: message_delta\n${sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 } })}`,
        `event: message_stop\n${sse({ type: 'message_stop' })}`,
      ].join(''),
    )
  })
})
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`

const read = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
type Rec = { runnerId: string; sessionId: string; pid?: number; endedAt?: number; stoppedAt?: number }
const recOf = (sid: string): Rec | undefined => {
  try {
    return Object.values((JSON.parse(read(join(daemonDir, 'concourse-workers.json'))) as { workers: Record<string, Rec> }).workers).find(w => w.sessionId === sid)
  } catch {
    return undefined
  }
}
const transcriptOf = (sid: string): string => read(join(paths.getProjectDir(work), `${sid}.jsonl`))
const facts = (sid: string): { busy?: boolean } | undefined => {
  try {
    return JSON.parse(read(join(daemonDir, 'session-facts', `${sid}.json`))) as { busy?: boolean }
  } catch {
    return undefined
  }
}
const logPath = join(SCRATCH, 'daemon.log')
const daemon: ChildProcess = spawn('node', [DIST, 'daemon', 'run', work], {
  cwd: work,
  env: {
    ...process.env,
    HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: daemonDir,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_OPERATOR: 'sam',
    MERCURY_DAEMON_OWNER_PID: String(process.pid),
    ANTHROPIC_API_KEY: 'fixture-key-000',
    ANTHROPIC_BASE_URL: base,
    OPENAI_API_KEY: '',
    MERCURY_CACHE_CLOCK: '0',
    MERCURY_PARTY: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_VERIFY_EVIDENCE: '0',
    MERCURY_WARM_RUNNER: '0',
  },
  stdio: ['ignore', openSync(logPath, 'a'), openSync(logPath, 'a')],
})
const dpid = daemon.pid ?? 0
let exitedAt: number | null = null
daemon.once('exit', () => {
  exitedAt = Date.now()
})
const cleanup = async (): Promise<void> => {
  if (exitedAt === null) {
    try {
      await daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 })
    } catch {}
    await untilAsync(() => exitedAt !== null, 8_000)
    try {
      daemon.kill('SIGKILL')
    } catch {}
  }
  await new Promise<void>(resolve => fixture.close(() => resolve()))
  if (failures === 0 && !KEEP) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

const GRACE_MS = 30_000
const BEAT_MS = 5_000
const CEILING_MS = GRACE_MS + BEAT_MS + 5_000

try {
  section('§1 an owned daemon hosts one session, then that session is stopped through the Concourse')
  check('the daemon came up', await untilAsync(async () => (await daemonControlRpc({ op: 'ping' } as never)).ok === true, 60_000), read(logPath).slice(-600))
  await sleep(12_000)
  check('a daemon that has hosted no session yet stays up (the owner is alive)', isProcessAlive(dpid) && exitedAt === null, read(logPath).slice(-400))
  const born = (await daemonControlRpc({ op: 'concourseDispatch', clientMessageId: 'sessionless-1', prompt: 'sessionless-probe: answer once', workspaceDir: work, title: 'Sessionless probe', model: 'claude-sonnet-5', effort: 'high' } as never, { timeoutMs: 30_000 })) as { ok?: boolean; sessionId?: string }
  const sid = born.sessionId ?? ''
  check('one session was born on the daemon', born.ok === true && sid !== '', JSON.stringify(born))
  check('it answered its turn', await untilAsync(() => transcriptOf(sid).includes('sessionless-probe: answered') && facts(sid)?.busy === false, 60_000), transcriptOf(sid).slice(-300))
  const runnerPid = recOf(sid)?.pid ?? 0
  check('the session runner is alive', runnerPid > 0 && isProcessAlive(runnerPid))
  const stopped = (await daemonControlRpc({ op: 'sessionControl', action: 'stop', sessionId: sid, by: 'operator' } as never, { timeoutMs: 15_000 })) as { ok?: boolean; outcome?: string; detail?: string }
  check('the session was stopped through the Concourse', stopped.ok === true && stopped.outcome === 'applied', JSON.stringify(stopped))
  const stoppedAtWall = Date.now()
  check('its record reads stopped and its runner is gone (the session has exited)', await untilAsync(() => recOf(sid)?.stoppedAt !== undefined && !isProcessAlive(runnerPid), 20_000), JSON.stringify(recOf(sid)))
  check('the owner of the daemon (this process) is still alive — the exit below is not the owner reap', isProcessAlive(process.pid))

  section(`§2 the daemon whose last session has exited exits within the grace (${GRACE_MS / 1000}s + one ${BEAT_MS / 1000}s beat)`)
  const left = await untilAsync(() => exitedAt !== null || !isProcessAlive(dpid), CEILING_MS)
  const afterMs = (exitedAt ?? Date.now()) - stoppedAtWall
  console.log(`  the daemon ${left ? `exited ${Math.round(afterMs / 1000)}s after its last session exited` : `is still running ${Math.round(afterMs / 1000)}s after its last session exited`}`)
  check(`the daemon exited on its own within ${CEILING_MS / 1000}s of its last session exiting`, left, `pid ${dpid} still alive; log tail: ${read(logPath).slice(-500)}`)
  check('…and not before the grace (a stop followed at once by a new session must find the daemon still there)', !left || afterMs >= GRACE_MS - BEAT_MS, `${afterMs} ms`)
  check('the daemon log names the reason', /the last session this daemon hosted has exited/.test(read(logPath)), read(logPath).slice(-500))
  check('its supervisor record is gone', !existsSync(supervisorStatePath()))
  check('its control socket is gone', process.platform === 'win32' || !existsSync(controlSockPath()))
  check('the stopped record is left for the board (the daemon leaves, the session history stays)', recOf(sid)?.stoppedAt !== undefined)

  section('§3 the decision: who holds a daemon with no session, who does not')
  try {
    const m = await import('../../src/daemon/sessionlessExit.ts')
    const facts0 = { live: 0, birthsInFlight: 0, superseded: false, persist: false, foreground: false, scheduled: false, now: 1_000_000 }
    const never = m.decideSessionlessExit(m.initialSessionlessState(), facts0)
    check('a daemon that never hosted a session is held (never hosted)', !never.exit && never.hold === 'never hosted a session', JSON.stringify(never))
    const hosted = m.decideSessionlessExit(m.initialSessionlessState(), { ...facts0, live: 1 })
    check('a live worker holds it and marks it as hosting', !hosted.exit && hosted.state.hosted && hosted.hold === '1 live worker(s)', JSON.stringify(hosted))
    const emptied = m.decideSessionlessExit(hosted.state, facts0)
    check('the first empty beat starts the grace, no exit yet', !emptied.exit && emptied.state.emptySince === 1_000_000, JSON.stringify(emptied))
    const late = m.decideSessionlessExit(emptied.state, { ...facts0, now: 1_000_000 + m.SESSIONLESS_EXIT_GRACE_MS })
    check(`the grace elapsed (${m.SESSIONLESS_EXIT_GRACE_MS / 1000}s) ⇒ exit, naming the exited session`, late.exit && /last session this daemon hosted has exited/.test(late.why), JSON.stringify(late))
    check('the grace is a minute at most', m.SESSIONLESS_EXIT_GRACE_MS <= 60_000 && m.SESSIONLESS_EXIT_BEAT_MS <= 10_000)
    const reborn = m.decideSessionlessExit(emptied.state, { ...facts0, live: 1, now: 1_000_000 + 10_000 })
    check('a session born inside the grace clears the clock', !reborn.exit && reborn.state.emptySince === null, JSON.stringify(reborn))
    const birth = m.decideSessionlessExit(emptied.state, { ...facts0, birthsInFlight: 1, now: 1_000_000 + m.SESSIONLESS_EXIT_GRACE_MS })
    check('a birth in flight holds it past the grace', !birth.exit && /birth/.test(birth.hold), JSON.stringify(birth))
    const persist = m.decideSessionlessExit(hosted.state, { ...facts0, persist: true, now: 1_000_000 + m.SESSIONLESS_EXIT_GRACE_MS * 2 })
    check('a persistent daemon (an explicit `mercury daemon`, or MERCURY_DAEMON_PERSIST) never exits for emptiness', !persist.exit && /persists/.test(persist.hold), JSON.stringify(persist))
    const supersededPersist = m.decideSessionlessExit(m.decideSessionlessExit(m.initialSessionlessState(), { ...facts0, persist: true, superseded: true }).state, { ...facts0, persist: true, superseded: true, now: 1_000_000 + m.SESSIONLESS_EXIT_GRACE_MS })
    check('…unless a newer daemon serves the plane: a superseded daemon exits once it holds nothing, persistent or not', supersededPersist.exit && /served by a newer daemon/.test(supersededPersist.why), JSON.stringify(supersededPersist))
    const scheduled = m.decideSessionlessExit(hosted.state, { ...facts0, scheduled: true, now: 1_000_000 + m.SESSIONLESS_EXIT_GRACE_MS * 2 })
    check('a session schedule waiting on the plane daemon holds it', !scheduled.exit && /schedule/.test(scheduled.hold), JSON.stringify(scheduled))
    const fg = m.decideSessionlessExit(hosted.state, { ...facts0, foreground: true, now: 1_000_000 + m.SESSIONLESS_EXIT_GRACE_MS * 2 })
    check('a daemon on a terminal is ended there, never by this rule', !fg.exit && /terminal/.test(fg.hold), JSON.stringify(fg))
  } catch (e) {
    check('the sessionless decision module exists (src/daemon/sessionlessExit.ts)', false, String(e).slice(0, 200))
  }
  section('§4 the wiring')
  {
    const main = read(join(REPO, 'src/daemon/main.ts'))
    check('the daemon beats the sessionless decision and shuts down on its verdict', main.includes('decideSessionlessExit(sessionless, {') && main.includes("requestShutdown('sessionless')"))
    check('the beat runs no subprocess (an in-memory live count, the plane owner the heal already read, one record read only when a candidate)', /const live = liveWorkers\(\)\.live\n\s+const superseded = planeServedByOther !== null && isProcessAlive\(planeServedByOther\.pid\)/.test(main))
    check('every birth door counts as in flight while it admits', main.includes('crewSpawn: (...args) => countBirth(() => crewSpawnHandler(...args))') && main.includes('concourseAdmit: (...args) => countBirth(() => concourseAdmitHandler(...args))') && main.includes('concourseDispatch: (...args) => countBirth(() => concourseDispatchHandler(...args))'))
    check('a spawned session marks the daemon as hosting', (main.match(/noteHosted\(\)/g) ?? []).length >= 3)
  }
} finally {
  await cleanup()
}
console.log(`\n${failures === 0 ? '✅ prove-sessionless-daemon-exits: ALL PASS' : `❌ prove-sessionless-daemon-exits: ${failures} FAIL`}`)
clearTimeout(guard)
process.exit(failures === 0 ? 0 : 1)
