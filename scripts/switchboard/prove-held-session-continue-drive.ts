#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-held-continue-')))
const HOME = join(SCRATCH, 'home')
const CWD = join(SCRATCH, 'project')
const DAEMON_DIR = join(HOME, 'daemon')
mkdirSync(CWD, { recursive: true })
mkdirSync(DAEMON_DIR, { recursive: true })
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: CWD })
execFileSync('git', ['-c', 'user.email=drive@fixture', '-c', 'user.name=drive', 'commit', '-q', '--allow-empty', '-m', 'ground'], { cwd: CWD })
writeFileSync(join(CWD, 'README.md'), '# fixture\n')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_CONCOURSE
delete process.env.MERCURY_HOME

const REPO = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_HELD_CONTINUE_BIN ?? join(REPO, 'dist', 'mercury.mjs')
const CAPTURE_DIR = process.env.MERCURY_HELD_CONTINUE_CAPTURE_DIR ?? null
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true })
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { daemonControlRpc } = await import('../../src/daemon/controlSocket.ts')
const paths = await import('../../src/utils/sessionStorage/paths.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-held-session-continue-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
seedFirstRun(HOME, [CWD])

const WORDS = 'first words for the held chat'
const REPLY = 'Held reply one.'
const WORDS2 = 'second words after the return'
const REPLY2 = 'Held reply two.'
const WORDS3 = 'words for the chat that parks'
const REPLY3 = 'Parked reply.'
const HELD_ROW = 'a live runner still holds this session'
const NO_RUNNER = 'no live runner'
const READY_LINE = '↵ start  ·  m menu  ·  ↑↓ choose'
const ARROW_DOWN = '\x1b[B'
const KILLS = 5
const PROVER_DEADLINE_MS = vshotBudgetMs(280_000)

const api = await startFixtureApi([
  { kind: 'text', text: REPLY, whenBody: WORDS },
  { kind: 'text', text: REPLY2, whenBody: WORDS2 },
  { kind: 'text', text: REPLY3, whenBody: WORDS3 },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
  { kind: 'text', text: 'Spare.' },
])
const worldEnv: Record<string, string> = {
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: DAEMON_DIR,
  ANTHROPIC_API_KEY: 'fixture-key-000',
  ANTHROPIC_BASE_URL: api.url,
  MERCURY_WARM_RUNNER: '0',
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_CACHE_CLOCK: '0',
  MERCURY_PARTY: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_OASIS_BG: '0',
  MERCURY_HIP: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  BROWSER: '/usr/bin/true',
}
const logFd = openSync(join(SCRATCH, 'daemon.log'), 'a')
const daemon = spawn('node', [BIN, 'daemon', 'run', CWD], { cwd: CWD, env: { ...process.env, ...worldEnv }, stdio: ['ignore', logFd, logFd] })

type Rec = { runnerId: string; sessionId: string; pid?: number; parkedAt?: number; parkReason?: string; stoppedAt?: number; crash?: { reason: string }; endedAt?: number; isolation?: string }
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const records = (): Rec[] => {
  try {
    return Object.values((JSON.parse(readFileSync(join(DAEMON_DIR, 'concourse-workers.json'), 'utf8')) as { workers: Record<string, Rec> }).workers)
  } catch {
    return []
  }
}
const recordOf = (sessionId: string): Rec | undefined => records().find(r => r.sessionId === sessionId && r.endedAt === undefined)
const isAlive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
async function until(cond: () => Promise<boolean> | boolean, ms: number, step = 200): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await cond()) return true
    } catch {
    }
    await sleep(step)
  }
  return false
}
const rpc = (body: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> => daemonControlRpc(body as never, { timeoutMs }) as Promise<Record<string, unknown>>
const has = async (short: string): Promise<{ alive: boolean; present: boolean; ready: boolean }> => {
  const r = await rpc({ op: 'has', short })
  return { alive: r.alive === true, present: r.present === true, ready: r.ready === true }
}
function reap(): void {
  for (const r of records()) {
    if (r.pid !== undefined) {
      try {
        process.kill(r.pid, 'SIGKILL')
      } catch {
      }
    }
  }
  try {
    if (daemon.pid !== undefined) process.kill(daemon.pid, 'SIGKILL')
  } catch {
  }
}
const watchdog = setTimeout(() => {
  console.error(`\n[watchdog] prover deadline ${PROVER_DEADLINE_MS / 1000}s — failing loud`)
  reap()
  process.exit(124)
}, PROVER_DEADLINE_MS)
watchdog.unref()
const bail = (why: string): never => {
  console.error(`  [bail] ${why}`)
  reap()
  process.exit(1)
}

type Send = Record<string, unknown>
type Resize = { cols: number; rows: number; afterMark?: string; afterMs?: number; afterPrevMs?: number }
type Grid = Array<Array<{ c: string }>>
type Capture = { text: string; marks: Map<string, { atTick: number; text: string }>; stages: Array<{ cols: number; rows: number; text: string }>; status: number; tail: string; startedAt: number }
const textOf = (grid: Grid): string => grid.map(row => row.map(cell => cell.c).join('').replace(/\s+$/, '')).join('\n')
async function capture(opts: { id: string; sends: Send[]; resizes: Resize[]; total: number }): Promise<Capture> {
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: ['node', BIN, '--model', 'claude-sonnet-5'], cwd: CWD, cols: 120, rows: 40, sends: opts.sends, resizes: opts.resizes, total: opts.total, out: outPath }),
  )
  const startedAt = Date.now()
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], { env: { ...process.env, ...worldEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
  let tail = ''
  child.stdout.on('data', d => (tail = (tail + String(d)).slice(-600)))
  child.stderr.on('data', d => (tail = (tail + String(d)).slice(-600)))
  const status = await new Promise<number>(resolve => child.on('close', code => resolve(code ?? 1)))
  const out: Capture = { text: '', marks: new Map(), stages: [], status, tail, startedAt }
  try {
    const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; atTick: number; grid: Grid }>; stages?: Array<{ cols: number; rows: number; grid: Grid }> }
    out.text = textOf(payload.grid)
    for (const m of payload.marks ?? []) out.marks.set(m.label, { atTick: m.atTick, text: textOf(m.grid) })
    for (const s of payload.stages ?? []) out.stages.push({ cols: s.cols, rows: s.rows, text: textOf(s.grid) })
    if (CAPTURE_DIR) {
      writeFileSync(join(CAPTURE_DIR, `${opts.id}.txt`), out.text + '\n')
      for (const [label, m] of out.marks) writeFileSync(join(CAPTURE_DIR, `${opts.id}--${label}.txt`), m.text + '\n')
      for (const s of out.stages) writeFileSync(join(CAPTURE_DIR, `${opts.id}--${s.cols}x${s.rows}.txt`), s.text + '\n')
    }
  } catch {
  }
  return out
}
const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 3, awaitSettleTicks: 2, data, ...extra })
const markText = (c: Capture, label: string): string => c.marks.get(label)?.text ?? ''
const stageOf = (c: Capture, cols: number, rows: number): string => c.stages.find(s => s.cols === cols && s.rows === rows)?.text ?? ''
const SIZES: Array<[number, number]> = [
  [80, 21],
  [80, 14],
  [82, 17],
]
const sizeResizes: Resize[] = [
  { afterMark: 'continued', afterMs: 500, cols: 80, rows: 21 },
  { afterPrevMs: 2500, cols: 80, rows: 14 },
  { afterPrevMs: 2500, cols: 82, rows: 17 },
  { afterPrevMs: 2500, cols: 120, rows: 40 },
]
function printFrame(id: string, text: string): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of text.split('\n')) console.log(`│${l}`)
  console.log('└──')
}
const footerLines = (text: string): string => text.split('\n').filter(l => /no live runner|already holds|revives it|still holds/.test(l)).join(' | ')

if (!(await until(async () => (await rpc({ op: 'ping' })).ok === true, vshotBudgetMs(30_000)))) bail('the daemon never served')

console.log('H — a session the daemon still holds: Continue Last Session inside the respawn backoff')
const admitted = await rpc({ op: 'sessionAdmit', workspaceDir: CWD, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'default' })
if (admitted.ok !== true) bail(`the session was not admitted: ${JSON.stringify(admitted)}`)
const sessionId = String(admitted.sessionId)
const runnerId = String(admitted.runnerId)
const transcript = join(paths.getProjectDir(CWD), `${sessionId}.jsonl`)
const sent = await rpc({ op: 'sessionDispatch', clientMessageId: 'held-words-1', prompt: WORDS, workspaceDir: CWD, targetSessionId: sessionId, by: 'operator' })
if (sent.ok !== true) bail(`the words were not delivered: ${JSON.stringify(sent)}`)
if (!(await until(() => existsSync(transcript) && readFileSync(transcript, 'utf8').includes(REPLY), vshotBudgetMs(60_000)))) bail('the fixture never answered the first words')
await sleep(vshotBudgetMs(1500))
const ladder: string[] = []
let killedPid: number | undefined
for (let n = 1; n <= KILLS; n++) {
  const pid = recordOf(sessionId)?.pid
  if (pid === undefined || !isAlive(pid)) bail(`kill ${n}: the record carries no live pid (${pid})`)
  process.kill(pid, 'SIGKILL')
  killedPid = pid
  const at = Date.now()
  if (n < KILLS) {
    const respawned = await until(() => {
      const r = recordOf(sessionId)
      return r?.pid !== undefined && r.pid !== killedPid && isAlive(r.pid)
    }, vshotBudgetMs(40_000), 100)
    ladder.push(`kill ${n} pid ${pid} → respawned ${respawned} after ${Date.now() - at} ms`)
    if (!respawned) bail(`the daemon never respawned the runner after kill ${n}`)
  } else {
    ladder.push(`kill ${n} pid ${pid} → the backoff window opens`)
  }
}
const windowOpenedAt = Date.now()
await sleep(300)
const heldHandle = await has(runnerId)
console.log(`  [ladder] ${ladder.join(' · ')}`)
check('H the roster keeps the runner\'s handle through the respawn backoff (present and unsettled) while the record\'s pid is dead', heldHandle.present && heldHandle.alive && !isAlive(recordOf(sessionId)?.pid), JSON.stringify({ ...heldHandle, pid: recordOf(sessionId)?.pid }))
const h = await capture({
  id: 'held-continue',
  sends: [
    g(READY_LINE, ARROW_DOWN),
    { afterPrevTicks: 2, data: '\r' },
    { afterPrevTicks: 20, data: '', mark: 'continued' },
    { afterPrevTicks: 90, data: WORDS2 },
    { afterPrevTicks: 2, data: '\r' },
    g(REPLY2, '', { minTick: 5, awaitSettleTicks: 3, mark: 'live' }),
  ],
  resizes: sizeResizes,
  total: 400,
})
const continued = markText(h, 'continued')
const live = markText(h, 'live')
const continuedTick = h.marks.get('continued')?.atTick
console.log(`  [timing] the capture started ${h.startedAt - windowOpenedAt} ms after the last kill; the continued mark at tick ${continuedTick ?? '∅'} (${continuedTick !== undefined ? `≈${h.startedAt - windowOpenedAt + continuedTick * 200} ms` : '∅'} after it; the window is 16 s); vshot status ${h.status}`)
printFrame('H 120×40 after Continue Last Session', continued)
check('H Continue Last Session landed in the chat: its words and the resume card are on screen', continued.includes(WORDS) && /resumed/.test(continued), footerLines(continued))
check('H the footer never says the session has no live runner while the daemon holds its runner (poison: the old red footer)', continued !== '' && !continued.includes(NO_RUNNER) && !continued.includes('already holds this id'), footerLines(continued))
check('H one receipt row says a live runner still holds the session and the chat re-attached to it', continued.includes(HELD_ROW), footerLines(continued))
const recAfter = recordOf(sessionId)
check('H the daemon never parked the held record (poison: parked with the already-holds sentence)', recAfter !== undefined && recAfter.parkedAt === undefined, JSON.stringify({ parkedAt: recAfter?.parkedAt, parkReason: recAfter?.parkReason }))
for (const [cols, rows] of SIZES) {
  const frame = stageOf(h, cols, rows)
  check(`H at ${cols}×${rows} the chat stands with its words and no no-live-runner footer`, frame.includes(WORDS) && !frame.includes(NO_RUNNER) && !frame.includes('already holds'), footerLines(frame) || frame.split('\n').slice(0, 2).join(' | '))
}
check('H the chat is the live session: the next words were answered in the same chat once the respawn landed', live.includes(WORDS2) && live.includes(REPLY2) && live.includes(WORDS), live === '' ? `no live mark; tail: ${h.tail.slice(-200)}` : footerLines(live))

console.log('R — a session with no runner (stopped, beside a live read-only holder): the refusal keeps the no-live-runner words')
const parkedFirst = await rpc({ op: 'sessionControl', action: 'park', sessionId, by: 'operator:drive' })
console.log(`  [park] the first session: ${JSON.stringify(parkedFirst).slice(0, 200)}`)
await until(() => recordOf(sessionId)?.parkedAt !== undefined, vshotBudgetMs(20_000))
const second = await rpc({ op: 'sessionAdmit', workspaceDir: CWD, isolation: 'shared', model: 'claude-sonnet-5', permissionMode: 'default' })
if (second.ok !== true) bail(`the second session was not admitted: ${JSON.stringify(second)}`)
const parkedId = String(second.sessionId)
const parkedRunner = String(second.runnerId)
const parkedTranscript = join(paths.getProjectDir(CWD), `${parkedId}.jsonl`)
const sent3 = await rpc({ op: 'sessionDispatch', clientMessageId: 'parked-words-1', prompt: WORDS3, workspaceDir: CWD, targetSessionId: parkedId, by: 'operator' })
if (sent3.ok !== true) bail(`the second session's words were not delivered: ${JSON.stringify(sent3)}`)
if (!(await until(() => existsSync(parkedTranscript) && readFileSync(parkedTranscript, 'utf8').includes(REPLY3), vshotBudgetMs(60_000)))) bail('the fixture never answered the second session')
await sleep(vshotBudgetMs(1500))
const stopped = await rpc({ op: 'sessionControl', action: 'stop', sessionId: parkedId, by: 'operator:drive' })
console.log(`  [stop] the second session: ${JSON.stringify(stopped).slice(0, 200)}`)
const stoppedDown = await until(async () => {
  const r = recordOf(parkedId)
  return r !== undefined && r.stoppedAt !== undefined && !isAlive(r.pid) && !(await has(parkedRunner)).alive
}, vshotBudgetMs(40_000), 250)
if (!stoppedDown) bail(`the stopped session's runner never settled: ${JSON.stringify({ record: recordOf(parkedId), handle: await has(parkedRunner) })}`)
const holder = await rpc({ op: 'sessionAdmit', workspaceDir: CWD, isolation: 'read-only', model: 'claude-sonnet-5', permissionMode: 'default' })
if (holder.ok !== true) bail(`the read-only holder was not admitted: ${JSON.stringify(holder)}`)
if (!(await until(async () => (await has(String(holder.runnerId))).ready, vshotBudgetMs(30_000)))) bail('the holder never came up')
const r = await capture({
  id: 'runnerless-continue',
  sends: [g(READY_LINE, ARROW_DOWN), { afterPrevTicks: 2, data: '\r' }, { afterPrevTicks: 20, data: '', mark: 'continued' }, { afterPrevTicks: 60, data: '', mark: 'settled' }],
  resizes: sizeResizes,
  total: 160,
})
const refused = markText(r, 'continued')
printFrame('R 120×40 after Continue Last Session on a parked session beside a live holder', refused)
const recRefused = recordOf(parkedId)
check('R the daemon refused the reactivate and left the record parked with its own reason', recRefused !== undefined && recRefused.parkedAt !== undefined && /held by a live session/.test(recRefused.parkReason ?? ''), JSON.stringify({ parkedAt: recRefused?.parkedAt, parkReason: recRefused?.parkReason }))
check('R the no-live-runner line paints with the daemon\'s reason, its words unchanged (↵ revives it · the checkout held by a live session)', refused.includes(WORDS3) && refused.includes('revives it') && /held by a live session/.test(refused), footerLines(refused))
check('R no re-attach row for a session without a runner', refused !== '' && !refused.includes(HELD_ROW), footerLines(refused))
for (const [cols, rows] of SIZES) {
  const frame = stageOf(r, cols, rows)
  check(`R at ${cols}×${rows} the refusal stands on the footer and no re-attach row paints`, frame.includes(WORDS3) && frame.includes('revives it') && !frame.includes(HELD_ROW), footerLines(frame) || frame.split('\n').slice(0, 2).join(' | '))
}

reap()
try {
  await api.close()
} catch {
}
clearTimeout(watchdog)
if (process.env.MERCURY_HELD_CONTINUE_KEEP !== '1') rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`  [keep] the world stays at ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-held-session-continue-drive: ALL LAWS HOLD' : `\nprove-held-session-continue-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
