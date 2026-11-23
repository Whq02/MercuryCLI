#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, FRAMES, NODE, makeTally } from '../daemon/dupline-world.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { encodeSeedTranscript } from '../lib/seedTranscript.ts'
import { getProjectDir } from '../../src/sessions/transcripts/paths.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-resume-conversation-drive')
const KEEP = process.argv.includes('--keep')
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const DOWN = '\x1b[B'

const driver = resolveCaptureDriver()
if (!existsSync(DIST)) {
  console.log(`  [SKIP] ${DIST} absent — build first`)
  process.exit(0)
}
if (driver.kind !== 'posix-pty') {
  console.log(`  [SKIP] no POSIX pty capture driver on this host (${driver.kind})`)
  process.exit(0)
}
console.log(`build under proof: ${DIST}`)
const PYTHON = driver.python

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'resume-conversation-drive-')))

type Cell = string | { c?: string } | null
type Grid = Cell[][]
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('')).join('\n')
const rowsOf = (frame: string | undefined): string[] => (frame ?? '').split('\n')
const has = (frame: string | undefined, needle: string): boolean => (frame ?? '').includes(needle)
const selectedRow = (frame: string | undefined): string => rowsOf(frame).find(r => r.includes('❯ '))?.trim() ?? ''

const SESSIONS = [
  {
    sid: '00000000-0000-4000-8000-000000000101',
    u: '00000000-0000-4000-8000-000000000102',
    a: '00000000-0000-4000-8000-000000000103',
    prompt: 'first session alpha prompt',
    reply: 'alpha saved reply marker',
    tsU: '2026-06-19T12:00:00.000Z',
    tsA: '2026-06-19T12:00:01.000Z',
    ageSec: 300,
  },
  {
    sid: '00000000-0000-4000-8000-000000000201',
    u: '00000000-0000-4000-8000-000000000202',
    a: '00000000-0000-4000-8000-000000000203',
    prompt: 'second session beta prompt',
    reply: 'beta saved reply marker',
    tsU: '2026-06-19T12:05:00.000Z',
    tsA: '2026-06-19T12:05:01.000Z',
    ageSec: 200,
  },
  {
    sid: '00000000-0000-4000-8000-000000000301',
    u: '00000000-0000-4000-8000-000000000302',
    a: '00000000-0000-4000-8000-000000000303',
    prompt: 'third session gamma prompt',
    reply: 'gamma saved reply marker',
    tsU: '2026-06-19T12:10:00.000Z',
    tsA: '2026-06-19T12:10:01.000Z',
    ageSec: 100,
  },
] as const

function seedWorld(name: string): { home: string; cwd: string } {
  const home = join(scratch, `home-${name}`)
  const cwd = join(scratch, `cwd-${name}`, 'fixture-cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({
    guardrails: { sovereignConsentSeen: true },
    view: { reducedMotion: true },
    activity: { tips: { enabled: false } },
  }, null, 2))
  const prevConfigDir = process.env.MERCURY_CONFIG_DIR
  process.env.MERCURY_CONFIG_DIR = home
  const projectDir = getProjectDir(cwd)
  if (prevConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevConfigDir
  mkdirSync(projectDir, { recursive: true })
  const nowSec = Math.floor(Date.now() / 1000)
  for (const s of SESSIONS) {
    const file = join(projectDir, `${s.sid}.jsonl`)
    writeFileSync(file, encodeSeedTranscript([
      { type: 'user', uuid: s.u, parentUuid: null, sessionId: s.sid, cwd, timestamp: s.tsU, message: { role: 'user', content: s.prompt } },
      { type: 'assistant', uuid: s.a, parentUuid: s.u, sessionId: s.sid, cwd, timestamp: s.tsA, message: { id: `msg-${s.sid}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: s.reply }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } } },
    ], s.sid, s.tsU))
    const mtime = nowSec - s.ageSec
    utimesSync(file, mtime, mtime)
  }
  return { home, cwd }
}

function driveEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_TERMINAL_TITLE: '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_CRITTER: 'clam',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_OASIS_BG: '0',
    MERCURY_JEV_BASE: 'http://127.0.0.1:1',
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: DEAD,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
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
    BROWSER: '/usr/bin/true',
    SHELL: existsSync('/bin/bash') ? '/bin/bash' : (process.env.SHELL ?? '/bin/sh'),
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'TYPESAFE_API_KEY', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'TERMINAL_EMULATOR']) {
    delete env[key]
  }
  return env
}

type Capture = { marks: Record<string, string>; sends: number; receipts: number; stderr: string; endReason: string; status: number | null }
async function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Capture> {
  const cfgPath = join(scratch, `${name}.cfg.json`)
  const outPath = join(scratch, `${name}.grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(PYTHON, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(180_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid }>; endReason?: string }
  const marks: Record<string, string> = {}
  for (const m of payload.marks ?? []) marks[m.label] = gridText(m.grid)
  marks.final = gridText(payload.grid)
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(FRAMES, `${name}-${label}.txt`), `${frame}\n`)
  }
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '', status }
}

const gated = (data: string, awaitText: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 1, awaitSettleTicks: 3, ...extra })
const dueDetail = (cap: Capture): string => `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`

async function pickSecondLeg(): Promise<void> {
  const { home, cwd } = seedWorld('pick-second')
  const env = driveEnv(home)
  try {
    const cap = await capture('pick-second-120x36', {
      cols: 120,
      rows: 36,
      total: 350,
      cwd,
      argv: [NODE, DIST, '--resume'],
      sends: [
        gated('', 'third session gamma prompt', { minTick: 2, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'picker' }),
        gated(DOWN, 'third session gamma prompt', { awaitSettleTicks: 2 }),
        gated('', 'second session beta prompt', { awaitPattern: '❯[^\\n]*second session beta prompt', awaitSettleTicks: 4, mark: 'after-down' }),
        gated('\r', 'second session beta prompt', { awaitPattern: '❯[^\\n]*second session beta prompt', awaitSettleTicks: 2 }),
        gated('', 'beta saved reply marker', { minTick: 2, awaitSettleTicks: 6, awaitStableTicks: 3, mark: 'resumed' }),
      ],
      readyText: 'beta saved reply marker',
      stableTicks: 4,
    }, env)
    const m = cap.marks
    tally.section('pick-second 120x36 · mercury --resume lists three sessions, ↓ selects the second, ↵ resumes its transcript')
    tally.check('R1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
    tally.check(
      'R2 picker opens with Mercury · resume and paints all three seeded sessions',
      has(m.picker, 'Mercury · resume') && has(m.picker, SESSIONS[2].prompt) && has(m.picker, SESSIONS[1].prompt) && has(m.picker, SESSIONS[0].prompt),
      rowsOf(m.picker).filter(r => r.trim() !== '').slice(0, 12).join(' | '),
    )
    tally.check('R3 initial focus stands on the newest session (gamma)', selectedRow(m.picker).includes(SESSIONS[2].prompt), selectedRow(m.picker) || '(no focused row)')
    tally.check('R4 ↓ moves focus down one row to the second session (beta)', selectedRow(m['after-down']).includes(SESSIONS[1].prompt), selectedRow(m['after-down']) || '(no focused row)')
    tally.check(
      'R5 ↵ closes the picker and paints the second session prompt and reply without the other sessions replies',
      !has(m.resumed, 'Mercury · resume') && has(m.resumed, SESSIONS[1].prompt) && has(m.resumed, SESSIONS[1].reply) && !has(m.resumed, SESSIONS[2].reply) && !has(m.resumed, SESSIONS[0].reply),
      rowsOf(m.resumed).filter(r => r.includes('session') || r.includes('marker') || r.includes('resume')).slice(0, 8).join(' | '),
    )
  } finally {
    spawnSync(NODE, [DIST, 'daemon', 'stop'], { env, cwd, timeout: 20_000, stdio: 'pipe' })
  }
}

async function searchAndCancelLeg(): Promise<void> {
  const { home, cwd } = seedWorld('search-cancel')
  const env = driveEnv(home)
  try {
    const cap = await capture('search-cancel-120x36', {
      cols: 120,
      rows: 36,
      total: 300,
      cwd,
      argv: [NODE, DIST, '--resume'],
      sends: [
        gated('', 'third session gamma prompt', { minTick: 2, awaitSettleTicks: 4, awaitStableTicks: 3 }),
        gated('/', 'third session gamma prompt', { awaitSettleTicks: 2 }),
        gated('alpha', 'third session gamma prompt', { awaitSettleTicks: 2 }),
        gated('', 'first session alpha prompt', { awaitPattern: '\\A(?![\\s\\S]*third session gamma prompt)', awaitSettleTicks: 3, awaitStableTicks: 2, mark: 'filtered' }),
        gated(ESC, 'first session alpha prompt', { awaitSettleTicks: 2 }),
        gated(ESC, 'third session gamma prompt', { awaitSettleTicks: 2 }),
        gated(ESC, 'esc close', { awaitSettleTicks: 2 }),
      ],
    }, env)
    const m = cap.marks
    tally.section('search-cancel 120x36 · /alpha filters the picker to the first session and esc exits without opening chat')
    tally.check('S1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
    tally.check(
      'S2 /alpha filters the list to alpha and hides beta and gamma',
      has(m.filtered, SESSIONS[0].prompt) && !has(m.filtered, SESSIONS[1].prompt) && !has(m.filtered, SESSIONS[2].prompt),
      rowsOf(m.filtered).filter(r => r.includes('session') || r.includes('alpha')).slice(0, 6).join(' | '),
    )
    tally.check(
      'S3 esc closes the picker without resuming any conversation',
      cap.endReason === 'eof' && !has(m.final, SESSIONS[0].reply) && !has(m.final, SESSIONS[1].reply) && !has(m.final, SESSIONS[2].reply),
      `endReason=${cap.endReason}`,
    )
  } finally {
    spawnSync(NODE, [DIST, 'daemon', 'stop'], { env, cwd, timeout: 20_000, stdio: 'pipe' })
  }
}

await pickSecondLeg()
await searchAndCancelLeg()

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
tally.finish()
