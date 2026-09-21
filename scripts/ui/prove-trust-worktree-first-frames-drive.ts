#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first or name a bundle with --dist`)
  process.exit(1)
}
const FRAMES = argAfter('--frames')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SCRATCH = realpathSync(mkdtempSync(join(existsSync('/private/tmp/mw') ? '/private/tmp/mw' : tmpdir(), 'trust-worktree-')))
const HOME = join(SCRATCH, 'home')
const MAIN = join(SCRATCH, 'main')
const LINKED = join(SCRATCH, 'linked')
mkdirSync(HOME, { recursive: true })
mkdirSync(MAIN, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = join(HOME, 'daemon')
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_HOME

const git = (args: string[], cwd: string): string => {
  const run = spawnSync('git', ['-c', 'user.email=proof@example.test', '-c', 'user.name=proof', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`)
  return run.stdout.trim()
}
git(['init', '-q', '-b', 'main'], MAIN)
writeFileSync(join(MAIN, 'README.md'), 'a repository\n')
git(['add', 'README.md'], MAIN)
git(['commit', '-q', '-m', 'first'], MAIN)
git(['worktree', 'add', '-q', LINKED, '-b', 'linked'], MAIN)

const { guardLoginDriverWrite } = await import('../lib/loginDriverGuard.ts')
guardLoginDriverWrite('the trust worktree drive', process.env)
const { canonicalProjectKeyOf, seedFirstRun } = await import('../lib/firstRunSeed.ts')
seedFirstRun(HOME, [MAIN])

type Projects = Record<string, { hasTrustDialogAccepted?: boolean }>
const projectsOf = (): Projects => {
  try {
    return (JSON.parse(readFileSync(join(HOME, '.mercury.json'), 'utf8')) as { projects?: Projects }).projects ?? {}
  } catch {
    return {}
  }
}

const childEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCURY_CONFIG_DIR: HOME,
  MERCURY_DAEMON_DIR: join(HOME, 'daemon'),
  MERCURY_HOME: '',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_CRITTER_GAZE: '0',
  MERCURY_CRITTER_IDLE: '0',
  MERCURY_CRITTER_SLEEP: '0',
  MERCURY_DECK_COMPANION: '0',
  MERCURY_TERMINAL_TITLE: '0',
  MERCURY_WARM_RUNNER: '0',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  MERCURY_CREDENTIAL_STORE: 'file',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
  MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
  MERCURY_OPENAI_CHATGPT_BASE: 'http://127.0.0.1:1',
  MERCURY_OPENAI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_OPENAI_AUTH_BASE: 'http://127.0.0.1:1',
  MERCURY_GEMINI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_DEEPSEEK_API_BASE: 'http://127.0.0.1:1',
  MERCURY_ZAI_API_BASE: 'http://127.0.0.1:1',
  MERCURY_MOONSHOT_API_BASE: 'http://127.0.0.1:1',
  MERCURY_HUGGINGFACE_API_BASE: 'http://127.0.0.1:1',
  BROWSER: '/usr/bin/true',
}
for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'ZAI_API_KEY', 'MOONSHOT_API_KEY', 'MERCURY_DISABLE_NONESSENTIAL_TRAFFIC']) delete childEnv[name]

type Mark = { label: string; atTick: number; grid: Array<Array<{ c: string }>> }
const TRUST_WORDS = ['Workspace trust', 'Accessing workspace', 'trust this folder']
const FACE_READY = '↑↓ choose'
const FIRST_TICKS = 50
const rowsOf = (grid: Mark['grid']): string[] => grid.map(row => row.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
const trustWordOn = (rows: string[]): string | undefined => TRUST_WORDS.find(word => rows.some(row => row.includes(word)))

type TeeFrame = { tick: number; text: string }
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78]|\r/g
function readTee(path: string): TeeFrame[] {
  const frames: TeeFrame[] = []
  if (!existsSync(path)) return frames
  const bytes = readFileSync(path)
  let at = 0
  while (at + 8 <= bytes.length) {
    const tick = bytes.readUInt32BE(at)
    const len = bytes.readUInt32BE(at + 4)
    frames.push({ tick, text: bytes.subarray(at + 8, at + 8 + len).toString('utf8').replace(ANSI, '') })
    at += 8 + len
  }
  return frames
}
const teeWordAt = (frames: TeeFrame[]): { tick: number; word: string; text: string } | undefined => {
  for (const frame of frames) {
    const word = TRUST_WORDS.find(candidate => frame.text.includes(candidate))
    if (word !== undefined) return { tick: frame.tick, word, text: frame.text }
  }
  const whole = frames.map(frame => frame.text).join('')
  const split = TRUST_WORDS.find(candidate => whole.includes(candidate))
  return split === undefined ? undefined : { tick: -1, word: split, text: whole.slice(Math.max(0, whole.indexOf(split) - 200), whole.indexOf(split) + 200) }
}

function runChild(command: string, args: string[], timeoutMs: number, extraEnv: Record<string, string> = {}): Promise<{ status: number | null; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { env: { ...childEnv, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stdout.on('data', () => {})
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('exit', code => {
      clearTimeout(killer)
      resolve({ status: code, stderr })
    })
  })
}

async function boot(size: string, cols: number, rows: number): Promise<{ marks: Mark[]; tee: TeeFrame[] } | null> {
  const driver = resolveCaptureDriver()
  if (driver.kind !== 'posix-pty') {
    console.log(`  [SKIP] capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
    return null
  }
  const out = join(SCRATCH, `boot-${size}.json`)
  const sends: Array<Record<string, unknown>> = [{ atTick: 1, data: '', mark: 'f001' }]
  for (let tick = 2; tick <= FIRST_TICKS; tick++) sends.push({ afterPrevTicks: 1, data: '', mark: `f${String(tick).padStart(3, '0')}` })
  sends.push({ atTick: 999, awaitText: FACE_READY, minTick: 5, awaitSettleTicks: 2, requireAwait: true, data: '', mark: 'face' })
  const cfgPath = join(SCRATCH, `boot-${size}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: ['node', BIN], cwd: LINKED, cols, rows, sends, total: 180, out }))
  const teePath = join(SCRATCH, `boot-${size}.tee`)
  const res = await runChild(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], vshotBudgetMs(300_000), { VSHOT_TEE: teePath })
  check(`${size}: the boot capture ran`, res.status === 0, res.stderr.slice(-240))
  let marks: Mark[] = []
  try {
    marks = (JSON.parse(readFileSync(out, 'utf8')) as { marks?: Mark[] }).marks ?? []
  } catch {
    marks = []
  }
  return { marks, tee: readTee(teePath) }
}

function saveFrames(size: string, marks: Mark[], tee: TeeFrame[]): void {
  if (!FRAMES) return
  mkdirSync(FRAMES, { recursive: true })
  const teeHit = teeWordAt(tee)
  if (teeHit !== undefined) writeFileSync(join(FRAMES, `trust-worktree-tee-${size}.txt`), `tick ${teeHit.tick} · ${teeHit.word}\n${teeHit.text}\n`)
  const offending = marks.find(mark => trustWordOn(rowsOf(mark.grid)) !== undefined)
  const face = marks.find(mark => mark.label === 'face')
  const first = marks[0]
  for (const [name, mark] of [['first', first], ['trust-chrome', offending], ['face', face]] as const) {
    if (mark === undefined) continue
    writeFileSync(join(FRAMES, `trust-worktree-${name}-${size}.txt`), `${rowsOf(mark.grid).join('\n')}\n`)
    writeFileSync(join(FRAMES, `trust-worktree-${name}-${size}.json`), JSON.stringify({ label: mark.label, atTick: mark.atTick, grid: mark.grid }))
  }
}

try {
  console.log('W the world: a trusted main checkout, a linked worktree the seed never keyed')
  const before = projectsOf()
  check('the seed trusts the main checkout under its own key', before[MAIN]?.hasTrustDialogAccepted === true, Object.keys(before).join(', '))
  check('the seed holds no key for the linked worktree', before[LINKED] === undefined, Object.keys(before).join(', '))
  check('the product keys the linked worktree to the main checkout (its common directory)', canonicalProjectKeyOf(LINKED) === MAIN, String(canonicalProjectKeyOf(LINKED)))

  for (const [cols, rows] of [[120, 40], [80, 21]] as const) {
    const size = `${cols}x${rows}`
    console.log(`B a boot in the linked worktree at ${size}: every frame from the first tick to the Boot face`)
    const booted = await boot(size, cols, rows)
    if (booted === null) continue
    const { marks, tee } = booted
    saveFrames(size, marks, tee)
    const face = marks.find(mark => mark.label === 'face')
    check(`${size}: the boot reached the Boot face`, face !== undefined && rowsOf(face.grid).some(row => row.includes('New Session')), face === undefined ? 'no face mark' : rowsOf(face.grid).slice(0, 12).join(' | ').slice(0, 300))
    check(`${size}: the first ${FIRST_TICKS} ticks were all sampled`, marks.filter(mark => /^f\d{3}$/.test(mark.label)).length === FIRST_TICKS, String(marks.length))
    const flashed = marks.filter(mark => trustWordOn(rowsOf(mark.grid)) !== undefined)
    const firstFlash = flashed[0]
    check(
      `${size}: no frame carries the workspace trust card or its chrome`,
      flashed.length === 0,
      firstFlash === undefined ? '' : `tick ${firstFlash.atTick} (${flashed.length} frame(s)): ${rowsOf(firstFlash.grid).filter(row => trustWordOn([row]) !== undefined).map(row => row.trim()).join(' | ').slice(0, 240)}`,
    )
    const teeHit = teeWordAt(tee)
    check(`${size}: the terminal was never sent the trust card's words (${tee.length} pty reads)`, tee.length > 0 && teeHit === undefined, teeHit === undefined ? '' : `tick ${teeHit.tick}: ${teeHit.word}`)
  }

  const after = projectsOf()
  check('after the boots the worktree carries its own grant, keyed as the shipped road keyed it', after[LINKED]?.hasTrustDialogAccepted === true, Object.keys(after).join(', '))
  check('the main checkout keeps its grant', after[MAIN]?.hasTrustDialogAccepted === true)
} catch (error) {
  failures++
  console.log(`  [FAIL] the drive threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (!process.argv.includes('--keep')) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`scratch kept at ${SCRATCH}`)
}
console.log(failures === 0 ? '✅ trust worktree first frames drive: all legs green' : `❌ trust worktree first frames drive: ${failures} leg(s) red`)
process.exit(failures === 0 ? 0 : 1)
