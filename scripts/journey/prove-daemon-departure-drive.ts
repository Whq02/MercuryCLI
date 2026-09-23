#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const DIST = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const FRAMES = argAfter('--frames')
const LABEL = argAfter('--label') ?? 'departure'
const SIZE = argAfter('--size') ?? '120x40'
const KEEP = process.argv.includes('--keep')
const DEPART_AFTER_MS = Number(argAfter('--depart-after') ?? '5000')
const [COLS, ROWS] = SIZE.split('x').map(n => Number.parseInt(n, 10)) as [number, number]
const FULL = COLS >= 100 && ROWS >= 26
const VENDORED_NODE = join(DIST, '..', 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const DEAD = 'http://127.0.0.1:9'

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const record = (label: string, detail: string): void => {
  console.log(`  [record] ${label}: ${detail}`)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (!existsSync(DIST)) {
  console.log(`FAIL ${DIST} missing — build first (the drive proves the BUILT binary)`)
  process.exit(1)
}
if (process.platform === 'win32') {
  console.log('SKIP the drive pauses the daemon with SIGSTOP, which win32 has no road for')
  process.exit(0)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.log(`SKIP the drive needs the POSIX capture engine: ${driver.kind === 'unavailable' ? driver.reason : driver.kind}`)
  process.exit(0)
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atTick: number; grid: Grid }
type Payload = { grid: Grid; marks?: Mark[]; endReason?: string; readyAt?: number | null; endedAtTick?: number }
const gridText = (grid: Grid): string => grid.map(r => r.map(c => c.c || ' ').join('')).join('\n')
const rowWith = (text: string, needle: string): string | undefined => text.split('\n').find(l => l.includes(needle))

const WORLD = join(realpathSync(tmpdir()), `mercury-departure-${process.pid}`)
rmSync(WORLD, { recursive: true, force: true })
const HOME = join(WORLD, 'home')
const WORK = join(WORLD, 'work')
const DAEMON_DIR = join(HOME, 'daemon')
for (const d of [HOME, WORK, DAEMON_DIR]) mkdirSync(d, { recursive: true })
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
seedFirstRun(HOME, [WORK])
writeFileSync(join(WORK, 'README.md'), '# departure drive fixture\n')

const env: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: DAEMON_DIR,
  MERCURY_CREDENTIAL_STORE: 'file',
  BROWSER: '/usr/bin/true',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: DEAD,
  MERCURY_OPENAI_API_BASE: DEAD,
  MERCURY_OPENAI_CHATGPT_BASE: DEAD,
  MERCURY_OPENAI_AUTH_BASE: DEAD,
  MERCURY_OPENROUTER_API_BASE: DEAD,
  MERCURY_OPENROUTER_AUTH_BASE: DEAD,
  MERCURY_GEMINI_API_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
  MERCURY_MOONSHOT_API_BASE: DEAD,
  MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
  MERCURY_MOONSHOT_CODING_BASE: DEAD,
  MERCURY_ZAI_API_BASE: DEAD,
  MERCURY_DEEPSEEK_API_BASE: DEAD,
  MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
  MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_TURN_RECEIPT: '0',
  MERCURY_VERIFY_EVIDENCE: '0',
  MERCURY_DOCTOR_STATE_DIR: join(HOME, 'doctor-state'),
  MERCURY_TEAMS_DIR: join(HOME, 'teams'),
  MERCURY_TABULA_DIR: join(HOME, 'tabula'),
}
for (const key of [
  'NODE_ENV',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'ZAI_API_KEY',
  'MOONSHOT_API_KEY',
  'DEEPSEEK_API_KEY',
  'HF_TOKEN',
  'MERCURY_COMPAT_BASE_URL',
  'MERCURY_LOCAL_BASE_URL',
  'MERCURY_LOCAL_API_KEY',
  'MERCURY_HUGGINGFACE_BILL_TO',
  'MERCURY_AUTH_SCOPE_DIR',
  'MERCURY_HOME',
  'MERCURY_RENDER_THEME',
  'MERCURY_THEME_PIN',
  'VSHOT_ACTIVE',
  'DEBUG',
  'MERCURY_DAEMON_OWNER_PID',
  'MERCURY_DAEMON_OWNER_FD',
  'MERCURY_DAEMON_PERSIST',
]) {
  delete env[key]
}
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON_DIR
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const manifest = JSON.parse(readFileSync(join(DIST, '..', 'manifest.json'), 'utf8')) as { version: string; buildTree?: string }
;(globalThis as Record<string, unknown>).MACRO = { VERSION: manifest.version }
const cs = await import('../../src/daemon/controlSocket.ts')
const { MERCURY_DAEMON_PROTO } = await import('../../src/daemon/protocol.ts')
type Raw = { ok: boolean; op?: string; ready?: boolean; pid?: number; code?: string; error?: string; warm?: number }
const hello = async (timeoutMs = 500): Promise<Raw> =>
  (await cs.daemonControlRpc({ op: 'hello', proto: MERCURY_DAEMON_PROTO, clientVersion: manifest.version, clientBuildTree: null } as never, { timeoutMs, protoRetry: false })) as Raw

console.log('============================================================')
console.log(' a cockpit booting beside a daemon on its way down spawns its own once it has left — the real binary')
console.log(`   dist: ${DIST} (v${manifest.version}${manifest.buildTree ? ` tree ${manifest.buildTree.slice(0, 8)}` : ''})`)
console.log(`   size: ${COLS}x${ROWS} (${FULL ? 'full' : 'compact'} layout) · departure ${DEPART_AFTER_MS}ms after the boot`)
console.log('============================================================')

const spawned: ChildProcess[] = []
const idler = spawn(NODE, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' })
spawned.push(idler)
await sleep(200)
const daemonLog = join(DAEMON_DIR, 'daemon.log')
const logFd = openSync(daemonLog, 'a')
const oldDaemon = spawn(NODE, [DIST, 'daemon', 'run', WORK], {
  cwd: WORK,
  detached: true,
  stdio: ['ignore', logFd, logFd, 'pipe'],
  env: { ...env, MERCURY_DAEMON_OWNER_PID: String(idler.pid), MERCURY_DAEMON_OWNER_FD: '3' },
})
oldDaemon.unref()
spawned.push(oldDaemon)
const pipeEnd = oldDaemon.stdio[3] as import('node:net').Socket | null
pipeEnd?.on('error', () => {})
pipeEnd?.unref()
const oldPid = oldDaemon.pid ?? 0

let up = false
for (let i = 0; i < 160 && !up; i++) {
  const r = await hello()
  if (r.ok && r.ready === true) up = true
  else await sleep(250)
}
check('the old daemon came up in the world (owned by a cockpit stand-in)', up, readFileSync(daemonLog, 'utf8').slice(-600))
for (let i = 0; i < 80 && up; i++) {
  const r = await hello(1500)
  if (r.ok && (r.warm ?? 0) > 0) break
  await sleep(250)
}
process.kill(oldPid, 'SIGSTOP')
const paused = await hello()
check('paused, the old daemon reads as a slow one (a 500ms hello times out)', !paused.ok && paused.code === 'ETIMEOUT', JSON.stringify(paused))

const landed = FULL ? '← back' : '1 session on'
const out = join(WORLD, 'grid.json')
const cfg = {
  argv: [NODE, DIST],
  cwd: WORK,
  sends: [
    { atTick: 150, minTick: 3, awaitText: '↑↓ choose', awaitSettleTicks: 2, data: '\r', mark: 'face' },
    { afterPrevTicks: 6, data: '', mark: 'opening' },
  ],
  readyText: [landed],
  readySettleTicks: 8,
  total: 300,
  cols: COLS,
  rows: ROWS,
  out,
}
const cfgPath = join(WORLD, 'cfg.json')
writeFileSync(cfgPath, JSON.stringify(cfg))
const bootAt = Date.now()
const capture = spawn(driver.python, [captureEngineEntry(driver, REPO), cfgPath], { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] })
let captureStderr = ''
capture.stderr.on('data', (chunk: Buffer) => {
  captureStderr += chunk.toString('utf8')
})
capture.stdout.on('data', () => {})
const exit = new Promise<number | null>(resolve => {
  const wall = setTimeout(() => {
    captureStderr += '\nthe capture wall was reached; the engine was killed'
    capture.kill('SIGKILL')
  }, vshotBudgetMs(200_000))
  capture.on('exit', code => {
    clearTimeout(wall)
    resolve(code)
  })
})

await sleep(vshotBudgetMs(DEPART_AFTER_MS))
const departAt = Date.now()
process.kill(oldPid, 'SIGTERM')
process.kill(oldPid, 'SIGCONT')
for (let i = 0; i < 60 && pidAlive(oldPid); i++) await sleep(100)
const goneAt = Date.now()
check('the old daemon left through its own SIGTERM road within the beat', !pidAlive(oldPid), `still alive ${goneAt - departAt}ms after the signal`)
record('the departure', `SIGTERM at +${((departAt - bootAt) / 1000).toFixed(1)}s after the boot; the process gone at +${((goneAt - bootAt) / 1000).toFixed(1)}s`)

let newDaemon: { pid: number; at: number } | null = null
let captureDone = false
void exit.then(() => {
  captureDone = true
})
while (!captureDone && newDaemon === null && Date.now() - departAt < vshotBudgetMs(50_000)) {
  try {
    const rec = JSON.parse(readFileSync(cs.supervisorStatePath(), 'utf8')) as { pid?: number }
    if (typeof rec.pid === 'number' && rec.pid !== oldPid && pidAlive(rec.pid)) newDaemon = { pid: rec.pid, at: Date.now() }
  } catch {
    await sleep(100)
    continue
  }
  if (newDaemon === null) await sleep(100)
}
record('the new daemon', newDaemon === null ? 'no new daemon held the plane before the capture ended' : `pid ${newDaemon.pid} holds the plane ${((newDaemon.at - departAt) / 1000).toFixed(1)}s after the departure`)

const status = await exit
let payload: Payload | null = null
if (existsSync(out)) payload = JSON.parse(readFileSync(out, 'utf8')) as Payload
const marks = payload?.marks ?? []
const markAt = (label: string): Mark | undefined => marks.find(m => m.label === label)
const seconds = (tick: number | null | undefined): string => (tick === null || tick === undefined ? '—' : `${(tick * 0.2).toFixed(1)}s`)
if (FRAMES !== undefined && payload !== null) {
  mkdirSync(FRAMES, { recursive: true })
  for (const m of marks) writeFileSync(join(FRAMES, `${LABEL}-${m.label}-${COLS}x${ROWS}.txt`), gridText(m.grid))
  writeFileSync(join(FRAMES, `${LABEL}-end-${COLS}x${ROWS}.txt`), gridText(payload.grid))
}
const face = markAt('face')
const opening = markAt('opening')
const endText = payload === null ? '' : gridText(payload.grid)
const refusalRow = rowWith(endText, 'the chat could not start') ?? (opening ? rowWith(gridText(opening.grid), 'the chat could not start') : undefined)
record('capture', `vshot=${status} end=${payload?.endReason ?? '?'} · face ${seconds(face?.atTick)} · New Session ${seconds(face?.atTick)} · opening ${seconds(opening?.atTick)} · landed ${seconds(payload?.readyAt)}`)
record('the refusal row', refusalRow === undefined ? 'none on the opening or the final frame' : refusalRow.trim().slice(0, 140))
const engaged = (readFileSync(daemonLog, 'utf8').match(/\[mercury-daemon\] engaged/g) ?? []).length
record('daemons in the log', `${engaged} engaged (the old one and every spawn)`)
check('the capture ended on the landed chat, not on its budget', status === 0 && payload?.endReason === 'ready', captureStderr.slice(-500))
check('the chat landed without a refusal: no "the chat could not start" row on the way', refusalRow === undefined, refusalRow?.trim())
const landedTick = payload?.readyAt ?? null
const departTick = Math.round((departAt - bootAt) / 200)
const landingBound = Math.round(100 * vshotBudgetScale())
check('the chat landed within twenty seconds of the departure (the ladder never ran out)', landedTick !== null && landedTick - departTick <= landingBound, `landed ${seconds(landedTick)} · departure ${seconds(departTick)}`)
check('a new daemon held the plane within six seconds of the departure', newDaemon !== null && newDaemon.at - departAt <= vshotBudgetMs(6000), newDaemon === null ? 'none' : `${newDaemon.at - departAt}ms`)
check("the cockpit spawned exactly one daemon after the old one's departure", engaged === 2, `${engaged} engaged lines`)

if (newDaemon !== null && pidAlive(newDaemon.pid)) {
  await cs.daemonControlRpc({ op: 'shutdown', reapWorkers: true } as never, { timeoutMs: 3000 }).catch(() => null)
  for (let i = 0; i < 50 && pidAlive(newDaemon.pid); i++) await sleep(100)
  if (pidAlive(newDaemon.pid)) {
    try {
      process.kill(newDaemon.pid, 'SIGTERM')
    } catch {
      record('cleanup', `the new daemon ${newDaemon.pid} could not be signalled`)
    }
  }
}
for (const c of spawned) {
  try {
    c.kill('SIGKILL')
  } catch {
    continue
  }
}
if (failures > 0 || KEEP) console.log(`  world kept: ${WORLD}`)
else rmSync(WORLD, { recursive: true, force: true })
console.log(`\n${checks} checks, ${failures} failures`)
console.log(failures === 0 ? 'prove-daemon-departure-drive: ALL LAWS HOLD' : `prove-daemon-departure-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
