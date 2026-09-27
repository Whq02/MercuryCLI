#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { FAKE_OLLAMA_MODEL, FAKE_OLLAMA_REPLY_PREFIX } from './fixtures/fake-ollama.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const SIZES = (argAfter('--sizes') ?? '178x51,80x21').split(',').map(s => s.trim()).filter(s => s !== '')
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const FIXTURES = join(import.meta.dir, 'fixtures')
const SERVER = join(FIXTURES, 'fake-ollama.ts')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:1'
const ESC = '\x1b'
const KEEP = process.env.LOCAL_SETUP_DRIVE_KEEP === '1'
const MODEL_ID = `local/${FAKE_OLLAMA_MODEL}`
const KEYS = '↵ run · s skip · esc stop'
const COMMAND = '/localsetup'
const FOLLOW_UP = 'what are you'
const REPLY_NEEDLE = `${FAKE_OLLAMA_REPLY_PREFIX}${FOLLOW_UP}`
const READY_ROW = /ready · local\/qwen3\.5:9b · (32k|64k|128k|256k) window · reply in \d+(\.\d+)? s · esc closes/

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})

if (!existsSync(BIN)) {
  console.error(`  ${BIN} missing — bun run build.ts first (or pass --dist <bundle>)`)
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
if (!existsSync(NODE)) {
  console.error(`  no node interpreter found for the pty child (looked for ${VENDORED_NODE} and node on PATH)`)
  process.exit(1)
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'local-setup-drive-')))

interface Step {
  mark: string
  pattern: string
  willRun: RegExp
  key: string
}

const STEPS: Step[] = [
  { mark: 'step1-find-server', pattern: '', willRun: /127\.0\.0\.1:\d+/, key: '\r' },
  { mark: 'step2-find-ollama', pattern: 'brew list --formula ollama|which ollama|command -v ollama|Ollama\\.app', willRun: /brew list --formula ollama|which ollama|command -v ollama|Ollama\.app/, key: '\r' },
  { mark: 'step2b-install', pattern: 'brew install ollama', willRun: /brew install ollama/, key: '\r' },
  { mark: 'step3-start', pattern: 'brew services start ollama|ollama serve', willRun: /brew services start ollama|ollama serve/, key: '\r' },
  { mark: 'step4-pull', pattern: '/api/pull', willRun: /POST .*\/api\/pull \{"model":"qwen3\.5:9b","stream":true\}/, key: '\r' },
  { mark: 'step5-window', pattern: '/api/show', willRun: /POST .*\/api\/show/, key: '\r' },
  { mark: 'step6-pick', pattern: '/api/chat|reply with the single word ready|/model local/', willRun: /\/api\/chat|\/model local\/qwen3\.5:9b|reply with the single word ready/, key: '\r' },
]

interface World {
  tag: string
  cols: number
  rows: number
  root: string
  home: string
  userHome: string
  cwd: string
  bin: string
  state: string
  log: string
  pidfile: string
  port: number
}

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

async function portAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/version`, { signal: AbortSignal.timeout(400) })
    return response.ok
  } catch {
    return false
  }
}

async function makeWorld(size: string): Promise<World> {
  const [cols, rows] = size.split('x').map(Number) as [number, number]
  const tag = `${cols}x${rows}`
  const root = join(ROOT, tag)
  const home = join(root, 'config-home')
  const userHome = join(root, 'user-home')
  const cwd = join(root, 'repo')
  const bin = join(root, 'fixture-bin')
  const state = join(root, 'fixture-state')
  for (const dir of [home, userHome, cwd, bin, state, join(userHome, 'Library', 'LaunchAgents'), join(userHome, 'Applications'), join(userHome, 'Downloads')]) mkdirSync(dir, { recursive: true })
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
  writeFileSync(join(cwd, 'README.md'), 'a fixture folder for the local set-up drive\n')
  const port = await freePort()
  return { tag, cols, rows, root, home, userHome, cwd, bin, state, log: join(state, 'requests.jsonl'), pidfile: join(state, 'server.pid'), port }
}

function childEnv(world: World): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${world.bin}:${join(FIXTURES, 'homebrew')}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: world.userHome,
    TMPDIR: join(world.root, 'tmp'),
    TERM: process.env.TERM ?? 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CONFIG_DIR: world.home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: `ollama=http://127.0.0.1:${world.port}`,
    OLLAMA_HOST: `127.0.0.1:${world.port}`,
    FAKE_OLLAMA_BIN: world.bin,
    FAKE_OLLAMA_STATE: world.state,
    FAKE_OLLAMA_BUN: process.execPath,
    FAKE_OLLAMA_SCRIPT: SERVER,
    FAKE_OLLAMA_LOG: world.log,
    FAKE_OLLAMA_PIDFILE: world.pidfile,
    FAKE_OLLAMA_PARENT_PID: String(process.pid),
    FAKE_OLLAMA_PULL_STEP_MS: '220',
    FAKE_OLLAMA_PULL_STEPS: '20',
    FAKE_OLLAMA_CHAT_DELAY_MS: '1500',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_DOCTOR_STATE_DIR: join(world.home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
    MERCURY_TEAMS_DIR: join(world.home, 'teams'),
    MERCURY_HOME: join(world.home, 'proof-home'),
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
    MERCURY_CUSTOM_OAUTH_URL: DEAD,
  }
  mkdirSync(env.TMPDIR!, { recursive: true })
  return env
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
interface Capture {
  status: number | null
  stderr: string
  lines: string[]
  marks: Map<string, string[]>
  undelivered: string
}
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

async function capture(world: World, sends: Send[], total: number): Promise<Capture> {
  const out = join(world.root, 'capture.json')
  const cfgPath = join(world.root, 'capture.cfg.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN], cwd: world.cwd, cols: world.cols, rows: world.rows, total, sends, out }))
  const inherited: NodeJS.ProcessEnv = {}
  for (const key of ['VSHOT_SLOTS', 'MERCURY_VSHOT_BUDGET_SCALE', 'MERCURY_VSHOT_EMULATOR', 'PYTHONPATH', 'VSHOT_TEE']) if (process.env[key] !== undefined) inherited[key] = process.env[key]
  const child = spawn(PYTHON, [VSHOT, cfgPath], { env: { ...childEnv(world), VSHOT_SLOTS: '999', ...inherited }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout!.on('data', () => {})
  child.stderr!.on('data', chunk => {
    stderr += String(chunk)
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const budget = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 90_000))
  const status = await exited.finally(() => clearTimeout(budget))
  const marks = new Map<string, string[]>()
  let lines: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    if (payload.grid) lines = textOf(payload.grid)
    for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
  }
  const undelivered = stderr.split('\n').filter(l => /UNDELIVERED|NEVER-READY|refus/i.test(l)).join(' ').replace(/\s+/g, ' ').trim()
  return { status, stderr, lines, marks, undelivered }
}

function dialogRows(lines: string[]): string[] {
  const at = lines.findIndex(l => l.includes(KEYS))
  if (at < 0) return []
  const line = lines[at]!
  const keysAt = line.indexOf(KEYS)
  const left = line.lastIndexOf('│', keysAt)
  const right = line.indexOf('│', keysAt + KEYS.length)
  if (left < 0 || right < 0) return lines.map(l => l.trim()).filter(l => l !== '')
  let top = at
  while (top > 0 && !'╭┌'.includes(lines[top]![left] ?? '')) top--
  let bottom = at
  while (bottom < lines.length - 1 && !'╰└'.includes(lines[bottom]![left] ?? '')) bottom++
  return lines.slice(top + 1, bottom).map(l => l.slice(left + 1, right).trim())
}

function judgeStep(world: World, step: Step, frame: string[]): void {
  const rows = dialogRows(frame)
  const keysAt = rows.findIndex(r => r.includes(KEYS))
  const willRunAt = rows.findIndex(r => step.willRun.test(r))
  const found = rows.slice(0, willRunAt < 0 ? rows.length : willRunAt).filter((r, i) => i > 0 && r !== '' && !r.includes(KEYS))
  check(`${world.tag} ${step.mark}: the keys line "${KEYS}" is on the dialog`, keysAt >= 0, frame.slice(-12).map(l => l.trim()).filter(l => l !== '').join(' | '))
  check(`${world.tag} ${step.mark}: the will-run line names the exact command or request (${step.willRun.source})`, willRunAt >= 0 && willRunAt < keysAt, rows.join(' | '))
  check(`${world.tag} ${step.mark}: a found line stands above the will-run line`, found.length >= 1, rows.join(' | '))
  check(`${world.tag} ${step.mark}: every dialog row fits the width (no row wraps into a neighbour)`, frame.every(l => l.length <= world.cols), String(frame.find(l => l.length > world.cols)?.length))
}

function listing(dir: string, depth: number): string {
  if (!existsSync(dir)) return `${dir}: absent`
  const rows: string[] = []
  const walk = (at: string, level: number): void => {
    let names: string[]
    try {
      names = readdirSync(at).sort()
    } catch {
      rows.push(`${at}: unreadable`)
      return
    }
    for (const name of names) {
      const path = join(at, name)
      try {
        const st = statSync(path)
        if (st.isDirectory()) {
          rows.push(`${path}/`)
          if (level < depth) walk(path, level + 1)
        } else rows.push(`${path} ${st.size} ${Math.floor(st.mtimeMs)}`)
      } catch {
        rows.push(`${path}: unreadable`)
      }
    }
  }
  walk(dir, 1)
  return rows.join('\n')
}

const REAL_HOME = homedir()
const outsideBefore = {
  mercury: listing(join(REAL_HOME, '.mercury'), 1),
  applications: listing('/Applications', 1),
  agents: listing(join(REAL_HOME, 'Library', 'LaunchAgents'), 1),
  downloads: listing(join(REAL_HOME, 'Downloads'), 1),
  ollama: listing(join(REAL_HOME, '.ollama'), 1),
}

function readLog(world: World): Array<{ at: number; method: string; path: string; body: unknown }> {
  if (!existsSync(world.log)) return []
  return readFileSync(world.log, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { at: number; method: string; path: string; body: unknown })
}

function stopFixture(world: World): void {
  if (!existsSync(world.pidfile)) return
  const pid = Number(readFileSync(world.pidfile, 'utf8').trim())
  if (pid > 0) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      void 0
    }
  }
}

function saveFrames(world: World, c: Capture): void {
  if (FRAMES === undefined) return
  mkdirSync(FRAMES, { recursive: true })
  for (const [mark, lines] of c.marks) writeFileSync(join(FRAMES, `${mark}-${world.tag}.txt`), lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
  writeFileSync(join(FRAMES, `final-${world.tag}.txt`), c.lines.map(l => l.replace(/\s+$/, '')).join('\n') + '\n')
}

async function drive(size: string): Promise<void> {
  const world = await makeWorld(size)
  const quietBefore = !(await portAnswers(world.port))
  const sends: Send[] = [
    { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 3, awaitStableTicks: 2, data: COMMAND },
    { requireAwait: true, awaitText: `❯ ${COMMAND}`, awaitStableTicks: 2, data: '\r' },
    ...STEPS.flatMap((step): Send[] => [
      { requireAwait: true, awaitText: KEYS, ...(step.pattern === '' ? {} : { awaitPattern: step.pattern }), awaitStableTicks: 3, mark: step.mark, data: step.key },
      ...(step.mark === 'step4-pull' ? [{ requireAwait: true, awaitText: 'pulling', awaitPattern: 'pulling [0-9a-f]{6,}|\\d+%', awaitSettleTicks: 1, mark: 'step4-pull-midway', data: '' }] : []),
    ]),
    { requireAwait: true, awaitText: `ready · ${MODEL_ID}`, awaitStableTicks: 3, mark: 'step6-ready', data: ESC },
    { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, awaitStableTicks: 2, data: FOLLOW_UP },
    { requireAwait: true, awaitText: FOLLOW_UP, awaitSettleTicks: 1, data: '\r' },
    { requireAwait: true, awaitText: REPLY_NEEDLE, awaitStableTicks: 3, mark: 'reply', data: '/exit\r' },
    { afterPrevTicks: 5, data: '' },
  ]
  const c = await capture(world, sends, 900)
  saveFrames(world, c)
  stopFixture(world)
  section(`${world.tag} — the road from a fresh home with no server answering to a Qwen reply`)
  check(`${world.tag}: the fixture port was quiet before the boot (discovery finds nothing)`, quietBefore)
  check(`${world.tag}: the drive delivered every send (vshot exit 0)`, c.status === 0, `exit ${c.status}: ${c.undelivered || c.stderr.trim().split('\n').slice(-6).join(' | ')}`)
  if (c.status !== 0) {
    const reached = [...c.marks.keys()]
    console.log(`  [record] steps reached before the stall: ${reached.join(', ') || 'none'}`)
    console.log(`  [record] the last frame:\n${c.lines.map(l => '    │' + l.replace(/\s+$/, '')).filter(l => l.trim() !== '│').slice(-Math.min(world.rows, 30)).join('\n')}`)
  }
  for (const step of STEPS) {
    const frame = c.marks.get(step.mark)
    if (frame === undefined) {
      check(`${world.tag} ${step.mark}: the step painted`, false, 'no frame captured')
      continue
    }
    judgeStep(world, step, frame)
  }
  const midway = c.marks.get('step4-pull-midway') ?? []
  check(`${world.tag} step4-pull-midway: one progress line names the digest and a percentage while the pull runs`, midway.some(l => /pulling [0-9a-f]{6,}.*\d+%|\d+%.*pulling/.test(l)), midway.filter(l => /pull/.test(l)).map(l => l.trim()).join(' | '))
  const ready = c.marks.get('step6-ready') ?? []
  const readyRow = ready.find(l => READY_ROW.test(l)) ?? ''
  check(`${world.tag} step6-ready: the last row reads ready · ${MODEL_ID} · <window> window · reply in <n> s · esc closes`, readyRow !== '', ready.filter(l => l.includes('ready')).map(l => l.trim()).join(' | '))
  const shownWindow = /(32k|64k|128k|256k) window/.exec(readyRow)?.[1]
  const reply = c.marks.get('reply') ?? []
  check(`${world.tag} reply: after esc closes the dialog a typed line ("${FOLLOW_UP}") gets the fixture's reply on the transcript`, reply.some(l => l.includes(REPLY_NEEDLE)), reply.slice(-10).map(l => l.trim()).filter(l => l !== '').join(' | '))
  const log = readLog(world)
  const pull = log.find(r => r.method === 'POST' && r.path === '/api/pull')
  check(`${world.tag}: the product started the fixture server itself (its pidfile was written under the scratch state) and the first request came from the product`, existsSync(world.pidfile) && log.length > 0, `pidfile ${existsSync(world.pidfile)} · ${log.length} requests`)
  check(`${world.tag}: the pull went through the API as POST /api/pull {"model":"qwen3.5:9b","stream":true}`, pull !== undefined && rec(pull.body).model === FAKE_OLLAMA_MODEL && rec(pull.body).stream === true, JSON.stringify(pull?.body))
  check(`${world.tag}: step 5 read the geometry with POST /api/show`, log.some(r => r.method === 'POST' && r.path === '/api/show' && rec(r.body).model === FAKE_OLLAMA_MODEL))
  const chats = log.filter(r => r.method === 'POST' && r.path === '/api/chat')
  const last = chats.at(-1)
  const lastText = JSON.stringify(last?.body ?? '')
  check(`${world.tag}: two chats reached the native road — the proving turn and the typed line — both with model qwen3.5:9b and options.num_ctx`, chats.length >= 2 && chats.every(r => rec(r.body).model === FAKE_OLLAMA_MODEL && typeof rec(rec(r.body).options).num_ctx === 'number') && lastText.includes(FOLLOW_UP), `${chats.length} chats · last num_ctx ${String(rec(rec(last?.body).options).num_ctx)}`)
  const numCtx = rec(rec(last?.body).options).num_ctx
  check(`${world.tag}: the window the ready row names is the window every request carries`, shownWindow !== undefined && typeof numCtx === 'number' && numCtx === Number(shownWindow.replace('k', '')) * 1024, `${shownWindow ?? '?'} vs ${String(numCtx)}`)
  const config = existsSync(join(world.home, '.mercury.json')) ? (JSON.parse(readFileSync(join(world.home, '.mercury.json'), 'utf8')) as { localModelWindows?: Record<string, unknown> }) : {}
  check(`${world.tag}: the per-model window setting landed in the scratch home (localModelWindows["${MODEL_ID}"])`, config.localModelWindows?.[MODEL_ID] !== undefined && (shownWindow === undefined || config.localModelWindows[MODEL_ID] === Number(shownWindow.replace('k', '')) * 1024), JSON.stringify(config.localModelWindows))
  const settings = existsSync(join(world.home, 'settings.json')) ? (JSON.parse(readFileSync(join(world.home, 'settings.json'), 'utf8')) as { model?: string }) : {}
  check(`${world.tag}: the session model was set through the /model road (settings.json carries model ${MODEL_ID})`, settings.model === MODEL_ID, JSON.stringify(settings))
  check(`${world.tag}: no request ever left for the real network or the live server (every logged request hit the fixture port)`, log.every(r => typeof r.path === 'string' && r.path.startsWith('/')) && !existsSync(join(world.userHome, 'Downloads', 'Ollama.dmg')))
  check(`${world.tag}: the fixture binary was installed into the scratch PATH directory, nowhere else`, existsSync(join(world.bin, 'ollama')))
  if (failures === 0 && !KEEP) rmSync(world.root, { recursive: true, force: true })
}

console.log('============================================================')
console.log(` /localsetup on the built product: a fresh home, no server, the fixture Ollama, a ${FAKE_OLLAMA_MODEL} reply`)
console.log(`   bundle: ${BIN}`)
console.log(`   sizes: ${SIZES.join(' ')}${FRAMES ? ` · frames: ${FRAMES}` : ''}`)
console.log('============================================================')

await Promise.all(SIZES.map(size => drive(size)))
await sleep(300)

section('nothing outside the scratch homes changed')
const outsideAfter = {
  mercury: listing(join(REAL_HOME, '.mercury'), 1),
  applications: listing('/Applications', 1),
  agents: listing(join(REAL_HOME, 'Library', 'LaunchAgents'), 1),
  downloads: listing(join(REAL_HOME, 'Downloads'), 1),
  ollama: listing(join(REAL_HOME, '.ollama'), 1),
}
for (const key of Object.keys(outsideBefore) as Array<keyof typeof outsideBefore>) {
  const before = outsideBefore[key].split('\n')
  const after = outsideAfter[key].split('\n')
  const changed = [...before.filter(l => !after.includes(l)), ...after.filter(l => !before.includes(l))]
  check(`the before/after listing of ${key === 'mercury' ? '~/.mercury' : key === 'applications' ? '/Applications' : key === 'agents' ? '~/Library/LaunchAgents' : key === 'downloads' ? '~/Downloads' : '~/.ollama'} (names, sizes, mtimes) is identical`, changed.length === 0, changed.slice(0, 6).join(' · '))
}

if (failures === 0 && !KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`\n  kept: ${ROOT}`)
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` local set-up drive: THE ROAD RUNS FROM NOTHING TO A ${FAKE_OLLAMA_MODEL} REPLY` : ` local set-up drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
