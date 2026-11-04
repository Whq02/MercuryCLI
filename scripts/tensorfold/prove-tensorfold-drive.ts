#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = resolve(argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs'))
const FRAMES = argAfter('--frames')
const SIZE = argAfter('--size') ?? '160x48'
const VSHOT = join(REPO, 'scripts', 'ui', 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:1'
const ESC = '\x1b'
const DOWN = '\x1b[B'
const COMMAND = '/tensorfold'
const PROMPT = 'What is the capital of France? Answer with the city name only.'
const REPLY = /\bParis\b/
const REPO_2B = 'mlx-community/Qwen3.5-2B-MLX-4bit'
const NAME_2B = 'qwen3.5-2b'
const REAL_CACHE = join(homedir(), '.cache', 'huggingface', 'hub')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

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
const TENSORFOLD = Bun.which('tensorfold', { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }) ?? Bun.which('tensorfold')
if (TENSORFOLD === null || TENSORFOLD === undefined) {
  console.error('  tensorfold is not on this Mac (brew install ashhart/tensorfold/tensorfold) — the live drive needs the real engine')
  process.exit(1)
}
if (!existsSync(join(REAL_CACHE, 'models--mlx-community--Qwen3.5-2B-MLX-4bit', 'refs', 'main'))) {
  console.error(`  the 2B is not in the Hugging Face cache (${REAL_CACHE}) — tensorfold pull ${REPO_2B} first`)
  process.exit(1)
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'tfd-')))

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

interface World { tag: string; cols: number; rows: number; root: string; home: string; userHome: string; cwd: string; port: number }

async function makeWorld(size: string): Promise<World> {
  const [cols, rows] = size.split('x').map(Number) as [number, number]
  const tag = `${cols}x${rows}`
  const root = join(ROOT, tag)
  const home = join(root, 'home')
  const userHome = join(root, 'user')
  const cwd = join(root, 'repo')
  for (const dir of [home, userHome, cwd, join(home, 'tensorfold')]) mkdirSync(dir, { recursive: true })
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  writeFileSync(join(cwd, 'README.md'), 'a fixture folder for the TensorFold drive\n')
  const port = await freePort()
  writeFileSync(join(home, 'tensorfold', 'served.json'), JSON.stringify({ repo: '', name: '', port, window: 0, pid: 0, startedAt: '', project: join(root, 'never') }) + '\n')
  return { tag, cols, rows, root, home, userHome, cwd, port }
}

function childEnv(world: World): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: `${dirname(TENSORFOLD!)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: world.userHome,
    TMPDIR: join(world.root, 'tmp'),
    TERM: process.env.TERM ?? 'xterm-256color',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    HF_HUB_CACHE: REAL_CACHE,
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CONFIG_DIR: world.home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_HEALTH_STATE_DIR: join(world.home, 'health-state'),
    MERCURY_DAEMON_DIR: join(world.home, 'daemon'),
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
    MERCURY_ANTHROPIC_OAUTH_BASE: DEAD,
  }
  mkdirSync(env.TMPDIR!, { recursive: true })
  return env
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
interface Capture { status: number | null; stderr: string; lines: string[]; marks: Map<string, string[]>; undelivered: string }
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

async function capture(world: World, argv: string[], sends: Send[], total: number, readyText: string): Promise<Capture> {
  const out = join(world.root, `capture-${sends.length}.json`)
  const cfgPath = join(world.root, `capture-${sends.length}.cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN, ...argv], cwd: world.cwd, cols: world.cols, rows: world.rows, total, sends, readyText, readySettleTicks: 25, out }))
  const inherited: NodeJS.ProcessEnv = {}
  for (const key of ['VSHOT_SLOTS', 'MERCURY_VSHOT_BUDGET_SCALE', 'MERCURY_VSHOT_EMULATOR', 'PYTHONPATH', 'VSHOT_TEE']) if (process.env[key] !== undefined) inherited[key] = process.env[key]
  const child = spawn(PYTHON, [VSHOT, cfgPath], { env: { ...childEnv(world), VSHOT_SLOTS: '999', ...inherited }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stdout!.on('data', () => {})
  child.stderr!.on('data', chunk => {
    stderr += String(chunk)
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const budget = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(total * 200 + 120_000))
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

const USER = userInfo().username
const scrub = (line: string): string => line.replace(/\s+$/, '').split(homedir()).join('~').split(ROOT).join('<scratch>').split(`[${USER}]`).join('[you]')

function saveFrames(world: World, c: Capture, prefix: string): void {
  if (FRAMES === undefined) return
  mkdirSync(FRAMES, { recursive: true })
  for (const [mark, lines] of c.marks) writeFileSync(join(FRAMES, `${prefix}-${mark}-${world.tag}.txt`), lines.map(scrub).join('\n') + '\n')
  writeFileSync(join(FRAMES, `${prefix}-final-${world.tag}.txt`), c.lines.map(scrub).join('\n') + '\n')
}

function servicePid(world: World): { pid: number; state: string; log: string } | null {
  const dir = join(world.home, 'services')
  if (!existsSync(dir)) return null
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  for (const slug of readdirSync(dir)) {
    const file = join(dir, slug, 'tensorfold.json')
    if (!existsSync(file)) continue
    const record = JSON.parse(readFileSync(file, 'utf8')) as { pid: number | null; state: string }
    return { pid: record.pid ?? 0, state: record.state, log: join(dir, slug, 'tensorfold.log') }
  }
  return null
}

function untilGone(pid: number, log: string, ceilingMs: number): Promise<boolean> {
  return new Promise(settle => {
    let watcher: FSWatcher | undefined
    let ceiling: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      if (ceiling !== undefined) clearTimeout(ceiling)
      watcher?.close()
      settle(!alive(pid))
    }
    try {
      watcher = watch(dirname(log), () => {
        if (!alive(pid)) finish()
      })
    } catch {
      watcher = undefined
    }
    ceiling = setTimeout(finish, vshotBudgetMs(ceilingMs))
    if (!alive(pid)) finish()
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(400) })
    return response.ok
  } catch {
    return false
  }
}

async function stopWhatWeStarted(world: World): Promise<boolean> {
  const service = servicePid(world)
  if (service === null || service.pid <= 0 || !alive(service.pid)) return true
  try {
    process.kill(service.pid, 'SIGTERM')
  } catch {
    return true
  }
  if (await untilGone(service.pid, service.log, 10_000)) return true
  try {
    process.kill(service.pid, 'SIGKILL')
  } catch {
    void 0
  }
  return !alive(service.pid)
}

const world = await makeWorld(SIZE)
const quietBefore = !(await portAnswers(world.port))

section(`${world.tag} — leg A: mercury /tensorfold at launch opens the panel`)
const launch = await capture(world, [COMMAND], [
  { requireAwait: true, awaitText: 'TENSORFOLD', minTick: 3, awaitStableTicks: 3, mark: 'launch-panel', data: ESC },
  { requireAwait: true, awaitText: '↑↓ choose', awaitSettleTicks: 2, awaitStableTicks: 2, mark: 'launch-boot-face', data: '' },
], 300, '↑↓ choose')
saveFrames(world, launch, 'launch')
check(`${world.tag} leg A: the drive delivered every send (vshot exit 0)`, launch.status === 0, `exit ${launch.status}: ${launch.undelivered || launch.stderr.trim().split('\n').slice(-8).join(' | ')}`)
const launchPanel = launch.marks.get('launch-panel') ?? []
check(`${world.tag} leg A: mercury /tensorfold at launch opened the panel straight away (no boot face stop) — the TENSORFOLD group with its version, chip and usable memory, the HOST group beneath, the live footer`, launchPanel.some(l => /TENSORFOLD · 1\.2\.2 · Apple .* · \d+(\.\d+)? GiB usable · nothing served/.test(l)) && launchPanel.some(l => l.includes('TENSORFOLD HOST')) && launchPanel.some(l => l.includes('nothing served · Metal')), launchPanel.filter(l => l.includes('TENSORFOLD') || l.includes('nothing served')).map(l => l.trim()).join(' | '))
check(`${world.tag} leg A: the three starting points are listed with the 2B on disk, the 27B landed as the best fit`, launchPanel.some(l => l.includes('Qwen3.8 27B')) && launchPanel.some(l => l.includes('Nemotron Lightning')) && launchPanel.some(l => l.includes('Qwen3.5 2B')), launchPanel.filter(l => l.includes('Qwen') || l.includes('Nemotron')).map(l => l.trim()).join(' | '))
const launchBoot = launch.marks.get('launch-boot-face') ?? []
check(`${world.tag} leg A: esc leaves the panel; with no session born behind a slash-command launch the chat settles to the boot face`, launchBoot.some(l => l.includes('↑↓ choose')) && launchBoot.some(l => l.includes('New Session')), launchBoot.filter(l => l.includes('choose')).map(l => l.trim()).join(' | '))

section(`${world.tag} — leg B: in a session, /tensorfold → ↓ ↓ to the 2B on disk → ↵ serves it on a free port and switches → a turn answers`)
const sends: Send[] = [
  { requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
  { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 3, awaitStableTicks: 2, data: COMMAND },
  { requireAwait: true, awaitText: `❯ ${COMMAND}`, awaitStableTicks: 2, data: '\r' },
  { requireAwait: true, awaitText: 'TENSORFOLD', awaitStableTicks: 3, mark: 'panel', data: DOWN },
  { requireAwait: true, awaitText: 'Qwen3.5 2B', awaitSettleTicks: 2, data: DOWN },
  { requireAwait: true, awaitText: 'Qwen3.5 2B', awaitSettleTicks: 2, awaitStableTicks: 2, mark: 'framed-2b', data: '\r' },
  { requireAwait: true, awaitText: `serving ${NAME_2B} on 127.0.0.1:${world.port}`, awaitStableTicks: 3, mark: 'served', data: ESC },
  { requireAwait: true, awaitText: 'Type a prompt', awaitSettleTicks: 2, awaitStableTicks: 2, mark: 'after-esc', data: PROMPT },
  { requireAwait: true, awaitText: 'capital of France', awaitSettleTicks: 1, data: '\r' },
  { requireAwait: true, awaitText: 'Paris', awaitStableTicks: 4, mark: 'reply', data: '/exit\r' },
]
const c = await capture(world, [], sends, 900, 'Paris')
saveFrames(world, c, 'drive')
const service = servicePid(world)
const servedAlive = service !== null && service.pid > 0 && alive(service.pid)
const answeredAfter = await portAnswers(world.port)
const stopped = await stopWhatWeStarted(world)
const quietAfter = !(await portAnswers(world.port))
check(`${world.tag}: the chosen high port was quiet before the boot`, quietBefore)
check(`${world.tag} leg B: the drive delivered every send (vshot exit 0)`, c.status === 0, `exit ${c.status}: ${c.undelivered || c.stderr.trim().split('\n').slice(-8).join(' | ')}`)
if (c.status !== 0) {
  console.log(`  [record] marks reached: ${[...c.marks.keys()].join(', ') || 'none'}`)
  console.log(`  [record] the last frame:\n${c.lines.map(l => '    │' + scrub(l)).filter(l => l.trim() !== '│').slice(-Math.min(world.rows, 34)).join('\n')}`)
}
const panel = c.marks.get('panel') ?? []
check(`${world.tag} panel: /tensorfold typed in the session opens the panel with the live footer`, panel.some(l => /TENSORFOLD · 1\.2\.2 · Apple .* · \d+(\.\d+)? GiB usable · nothing served/.test(l)) && panel.some(l => l.includes('nothing served · Metal')), panel.filter(l => l.includes('TENSORFOLD') || l.includes('nothing served')).map(l => l.trim()).join(' | '))
const framed = c.marks.get('framed-2b') ?? []
check(`${world.tag} framed-2b: the 2B's card shows the exact serve it will run on the remembered port`, framed.map(l => l.replace(/[│╭╮╰╯─]/g, ' ').trim()).join(' ').replace(/\s+/g, ' ').includes(`tensorfold serve ${REPO_2B} --name ${NAME_2B} --context 262144 --prompt-cache-gib 1 --port ${world.port}`), framed.filter(l => l.includes('tensorfold serve') || l.includes('--port')).map(l => l.trim()).join(' | '))
const served = c.marks.get('served') ?? []
check(`${world.tag} served: ↵ served the 2B through the engine on 127.0.0.1:${world.port}; the heading says 1 serving; the row reads current`, served.some(l => l.includes(`serving ${NAME_2B} on 127.0.0.1:${world.port}`)) && served.some(l => l.includes('· 1 serving')) && served.some(l => l.includes('Qwen3.5 2B') && l.includes('current')), served.filter(l => l.includes('serving') || l.includes('Qwen3.5 2B')).map(l => l.trim()).join(' | '))
const afterEsc = c.marks.get('after-esc') ?? []
check(`${world.tag} after-esc: the panel closed over the live session and the feed carries ● TensorFold serves ${NAME_2B} · 256k on 127.0.0.1:${world.port} · this session's model`, afterEsc.some(l => l.includes(`TensorFold serves ${NAME_2B} · 256k on 127.0.0.1:${world.port} · this session's model`)), afterEsc.filter(l => l.includes('TensorFold')).map(l => l.trim()).join(' | '))
const reply = c.marks.get('reply') ?? []
check(`${world.tag} reply: the session switched to the served 2B and a turn answered — a transcript line says Paris and is not the prompt`, reply.some(l => REPLY.test(l) && !l.includes('❯') && !l.includes('capital')), reply.filter(l => l.includes('Paris') || l.includes('capital')).map(l => l.trim()).join(' | '))
check(`${world.tag} reply: the turn ran on the 2B (the strip names qwen3.5-2b, not a cloud model)`, reply.some(l => l.includes('qwen3.5-2b') && !l.includes('TensorFold serves') && !l.includes('❯')) && !reply.some(l => l.includes('Opus 5.5 ·')), reply.filter(l => l.includes('qwen3.5-2b') || l.includes('Opus')).map(l => l.trim().slice(0, 140)).join(' | '))
check(`${world.tag}: the product started the engine itself as the tensorfold project service — its record reads ready with a pid (vshot's teardown sweeps every descendant of the captured app, so the engine outliving the app is pinned by prove-tensorfold-serve's reattach row and the detached-parent reading in the receipt, not here)`, service !== null && service.state === 'ready' && service.pid > 0, JSON.stringify({ service, servedAlive, answeredAfter }))
check(`${world.tag}: nothing the drive started is left running (SIGTERM to the service's pid when it was still up); the port is quiet again`, stopped && quietAfter)
const servedFile = join(world.home, 'tensorfold', 'served.json')
const record = existsSync(servedFile) ? (JSON.parse(readFileSync(servedFile, 'utf8')) as { repo: string; port: number; window: number } | null) : null
check(`${world.tag}: the served record names the 2B at 256k on the chosen port (what the next /tensorfold reattaches to)`, record !== null && record.repo === REPO_2B && record.port === world.port && record.window === 262_144, JSON.stringify(record))

console.log(`\n${failures === 0 ? 'GREEN' : `RED (${failures})`}: the TensorFold live drive on this Mac`)
process.exit(failures === 0 ? 0 : 1)
