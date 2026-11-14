#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs, vshotBudgetScale } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { untilAsync } from '../lib/untilAsync.ts'
import { FAKE_BIN, FIXTURES, fakeWorld } from './fixtures/world.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const ADAPTER = join(dirname(BIN), 'tensorfold-adapter.mjs')
const FRAMES = argAfter('--frames')
const HOLD_S = Number(argAfter('--hold') ?? 100)
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:1'
const PROMPT = 'Reply with exactly five words about rain.'
const REPO_2B = 'mlx-community/Qwen3.5-2B-MLX-4bit'
const NAME_2B = 'qwen3.5-2b'
const REPLY = 'hello from llama.cpp'
const PING_S = 30
const ESTIMATE_S = 60

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

if (!existsSync(BIN) || !existsSync(ADAPTER)) {
  console.error(`  ${existsSync(BIN) ? ADAPTER : BIN} missing — bun run build.ts first (or pass --dist <bundle>)`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`  no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(1)
}
const PYTHON = driver.python
const VENDORED_NODE = join(dirname(BIN), 'vendor', 'node', 'bin', 'node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : (Bun.which('node') ?? 'node')

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'tfw-')))
process.env.MERCURY_CONFIG_DIR = join(ROOT, 'proof-home')
const models = await import('../../src/services/tensorfold/adapter/models.ts')
const identity = await import('../../src/services/tensorfold/adapter/identity.ts')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}
const answers = async (port: number): Promise<boolean> => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) }).then(r => r.ok, () => false)

const scale = vshotBudgetScale()
const holdMs = Math.round(HOLD_S * 1000 * scale)
const world = fakeWorld('tfw-engine', { seeds: [], ggufSeeds: [models.QWEN_2B_GGUF.gguf], env: { FAKE_LLAMA_SCRIPT: join(FIXTURES, 'fake-llama-server.ts'), FAKE_TENSORFOLD_BUN: process.execPath, FAKE_LLAMA_INGEST_MS: String(holdMs), FAKE_LLAMA_PING_MS: String(PING_S * 1000) } })
const runtime = join(world.home, ...identity.LLAMACPP_RUNTIME_BIN)
mkdirSync(runtime, { recursive: true })
copyFileSync(join(FAKE_BIN, 'llama-server'), join(runtime, 'llama-server'))
const llamaLog = join(world.root, 'llama.log')
const port = await freePort()
const engine = spawn(NODE, [ADAPTER, identity.ADAPTER_FLAG, 'serve', REPO_2B, '--name', NAME_2B, '--context', '32768', '--prompt-cache-gib', '1', '--port', String(port)], { env: { ...world.env, HOME: world.home, TF_DRAIN_S: '2', FAKE_LLAMA_LOG: llamaLog }, stdio: ['ignore', 'pipe', 'pipe'] })
const engineLines: string[] = []
for (const stream of [engine.stdout!, engine.stderr!]) stream.on('data', chunk => engineLines.push(...String(chunk).split(/\r?\n/).filter(line => line.trim() !== '')))
const engineGone = new Promise<void>(settle => engine.once('exit', () => settle()))
const stopEngine = async (): Promise<void> => {
  if (engine.exitCode !== null || engine.signalCode !== null) return
  engine.kill('SIGTERM')
  const deadline = setTimeout(() => engine.kill('SIGKILL'), vshotBudgetMs(8_000))
  await engineGone.finally(() => clearTimeout(deadline))
}

const [cols, rows] = (argAfter('--size') ?? '100x40').split('x').map(Number) as [number, number]
const home = join(ROOT, 'home')
const userHome = join(ROOT, 'user')
const cwd = join(ROOT, 'repo')
for (const dir of [home, userHome, cwd, join(ROOT, 'tmp')]) mkdirSync(dir, { recursive: true })
seedFirstRun(home, [cwd])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
writeFileSync(join(cwd, 'README.md'), 'a fixture folder for the waiting-row drive\n')

const childEnv: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: userHome,
  TMPDIR: join(ROOT, 'tmp'),
  TERM: process.env.TERM ?? 'xterm-256color',
  LANG: process.env.LANG ?? 'en_US.UTF-8',
  ANTHROPIC_API_KEY: KEY,
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_LOCAL_PROBE_TARGETS: `tensorfold=http://127.0.0.1:${port}`,
  MERCURY_CRITTER: 'clam',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
  MERCURY_DAEMON_DIR: join(home, 'daemon'),
  MERCURY_HOME: join(home, 'proof-home'),
  BROWSER: 'true',
  ANTHROPIC_BASE_URL: DEAD,
  MERCURY_OPENAI_API_BASE: DEAD,
  MERCURY_OPENAI_CHATGPT_BASE: DEAD,
  MERCURY_OPENAI_AUTH_BASE: DEAD,
  MERCURY_OPENROUTER_API_BASE: DEAD,
  MERCURY_OPENROUTER_AUTH_BASE: DEAD,
  MERCURY_GEMINI_API_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
  MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
  MERCURY_HUGGINGFACE_API_BASE: `${DEAD}/v1`,
  MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
  MERCURY_MOONSHOT_API_BASE: `${DEAD}/v1`,
  MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
  MERCURY_MOONSHOT_CODING_BASE: `${DEAD}/v1`,
  MERCURY_ZAI_API_BASE: `${DEAD}/v4`,
  MERCURY_DEEPSEEK_API_BASE: DEAD,
  MERCURY_ANTHROPIC_OAUTH_BASE: DEAD,
}

type Grid = Array<Array<{ c: string }>>
type Mark = { label: string; atMs: number; lines: string[] }
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c || ' ').join(''))
const READINGS = HOLD_S >= 200 ? [22, 40, 50, 70, 95, 125, 155, 185, 200] : [22, 40, 50, 70, 92]
const ticks = (seconds: number): number => Math.round(seconds * 5)
const sends: Array<Record<string, unknown>> = [
  { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'session', data: PROMPT },
  { requireAwait: true, awaitText: 'five words about rain', awaitSettleTicks: 1, mark: 'asked', data: '\r' },
  ...READINGS.map((at, n) => ({ afterPrevTicks: ticks(at - (READINGS[n - 1] ?? 0)), awaitPattern: `local/${NAME_2B}[^\\n]*(?:first byte|ingest|so far)`, mark: `reading-${n + 1}`, data: '' })),
]

section(`${cols}x${rows} — a session on ${NAME_2B} behind Mercury's engine and a llama.cpp that reads the prompt for ${Math.round(holdMs / 1000)} s, a comment line every ${PING_S} s`)
const up = await untilAsync(() => answers(port), vshotBudgetMs(30_000), 150)
check('the engine answers on its port before the session starts', up, engineLines.slice(-6).join(' | '))

const out = join(ROOT, 'capture.json')
const cfgPath = join(ROOT, 'capture.cfg.json')
const total = ticks(HOLD_S + 60)
writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN, '--model', `local/${NAME_2B}`], cwd, cols, rows, total, sends, readyText: REPLY, readySettleTicks: 15, out }))
const inherited: NodeJS.ProcessEnv = {}
for (const key of ['VSHOT_SLOTS', 'MERCURY_VSHOT_BUDGET_SCALE', 'MERCURY_VSHOT_EMULATOR', 'PYTHONPATH', 'VSHOT_TEE']) if (process.env[key] !== undefined) inherited[key] = process.env[key]
const child = spawn(PYTHON, [VSHOT, cfgPath], { env: { ...childEnv, VSHOT_SLOTS: '999', ...inherited }, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stdout!.on('data', () => {})
child.stderr!.on('data', chunk => {
  stderr += String(chunk)
})
const exited = new Promise<number | null>(settle => child.on('exit', code => settle(code)))
const budget = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 120_000))
const status = await exited.finally(() => clearTimeout(budget))
await stopEngine()

const marks: Mark[] = []
let final: string[] = []
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; atMs: number; grid: Grid }> }
  if (payload.grid) final = textOf(payload.grid)
  for (const mark of payload.marks ?? []) marks.push({ label: mark.label, atMs: mark.atMs, lines: textOf(mark.grid) })
}
const scrub = (line: string): string => line.replace(/\s+$/, '').split(ROOT).join('<scratch>')
if (FRAMES !== undefined) {
  mkdirSync(FRAMES, { recursive: true })
  for (const mark of marks) writeFileSync(join(FRAMES, `wait-row-${mark.label}-${cols}x${rows}.txt`), mark.lines.map(scrub).join('\n') + '\n')
  writeFileSync(join(FRAMES, `wait-row-final-${cols}x${rows}.txt`), final.map(scrub).join('\n') + '\n')
}
const undelivered = stderr.split('\n').filter(line => /UNDELIVERED|NEVER-READY|refus/i.test(line)).join(' ').replace(/\s+/g, ' ').trim()
check('the drive delivered every send (vshot exit 0)', status === 0, `exit ${status}: ${undelivered || stderr.trim().split('\n').slice(-8).join(' | ')}`)

const asked = marks.find(mark => mark.label === 'asked')
const rowOf = (lines: readonly string[]): string => lines.find(line => line.includes(`local/${NAME_2B}`) && (line.includes('first byte') || line.includes('ingesting') || line.includes('so far'))) ?? lines.find(line => line.includes(`local/${NAME_2B}`)) ?? ''
const countOf = (row: string): number | null => {
  const match = / · (\d+)(s|m) so far/.exec(row)
  return match === null ? null : Number(match[1]) * (match[2] === 'm' ? 60 : 1)
}
type Reading = { label: string; at: number; row: string; count: number | null; estimate: boolean }
const readings: Reading[] = marks.filter(mark => mark.label.startsWith('reading-')).map(mark => {
  const row = rowOf(mark.lines)
  return { label: mark.label, at: asked === undefined ? -1 : (mark.atMs - asked.atMs) / 1000, row: row.trim(), count: countOf(row), estimate: row.includes('expected in about') }
})
console.log('\n  the status row, reading by reading (seconds from the Enter of the ask):')
for (const reading of readings) console.log(`    +${reading.at.toFixed(0)} s · ${reading.row.replace(/\s+/g, ' ')}`)
const held = readings.filter(reading => reading.at > 0 && reading.at < holdMs / 1000 - 4)
check('every reading was taken while the prompt was still being read', held.length === readings.length && readings.length === READINGS.length, JSON.stringify(readings.map(reading => [reading.label, Math.round(reading.at)])))
const ageOf = (reading: Reading): { low: number; high: number } => ({ low: reading.at - 8, high: reading.at + 1 })
const countsAge = (reading: Reading): boolean => {
  if (reading.count === null) return false
  const { low, high } = ageOf(reading)
  return reading.count < 60 ? reading.count >= low && reading.count <= high : reading.count <= high && reading.count + 60 > low
}
check('at every reading the row counts the wait\'s own age, from the ask to the first byte', held.length > 0 && held.every(countsAge), JSON.stringify(held.map(reading => [Math.round(reading.at), reading.count])))
const pastPing = held.filter(reading => reading.at > PING_S + 6 && reading.at < ESTIMATE_S - 2)
check('past the first keep-alive and inside the estimate the count has passed thirty seconds and the estimate still stands', pastPing.length > 0 && pastPing.every(reading => reading.count !== null && reading.count > PING_S && reading.estimate), JSON.stringify(pastPing))
const pastEstimate = held.filter(reading => reading.at > ESTIMATE_S + 9)
check('past the estimate the count reads minutes and the row states no estimate', pastEstimate.length > 0 && pastEstimate.every(reading => reading.count !== null && reading.count >= 60 && !reading.estimate && / · \d+m so far/.test(reading.row)), JSON.stringify(pastEstimate))
if (HOLD_S >= 200) {
  const pastThree = held.filter(reading => reading.at > 189)
  check('past three minutes it reads 3m so far', pastThree.length > 0 && pastThree.every(reading => reading.count === 180), JSON.stringify(pastThree))
}
const before = held.filter(reading => reading.at < PING_S - 2)
check('before the first keep-alive the row is the promise with its count, as it was', before.length > 0 && before.every(reading => reading.estimate && countsAge(reading)), JSON.stringify(before))
check('the reply arrives once the prompt is read and the row rests', final.some(line => line.includes(REPLY)) && !final.some(line => line.includes('so far')), final.filter(line => line.trim() !== '').slice(-8).map(scrub).join(' | '))
const log = existsSync(llamaLog) ? readFileSync(llamaLog, 'utf8') : ''
check('the fixture held one request for the whole reading and nothing closed it early', log.split('\n').filter(line => line.startsWith('ingesting ')).length >= 1 && log.includes('ingested') && !log.includes('client closed before the end'), log.split('\n').filter(line => !line.startsWith('request ') && !line.startsWith('args ')).join(' | '))

if (failures === 0) rmSync(ROOT, { recursive: true, force: true })
else console.log(`\n  [record] the world is kept at ${ROOT}`)
rmSync(world.root, { recursive: true, force: true })
console.log(`\nprove-tensorfold-wait-row-drive: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
