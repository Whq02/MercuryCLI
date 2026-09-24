#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { seedFirstRun } from '../lib/firstRunSeed.ts'

const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const BIN = argAfter('--dist') ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
const VSHOT = join(import.meta.dir, 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:1'
const ESC = '\x1b'
const DOWN = `${ESC}[B`
const HOME = `${ESC}[H`
const COLS = 120
const ROWS = 40
const KEEP = process.env.PICKER_ONE_ROW_KEEP === '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'picker-one-row-drive-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CONFIG_DIR: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    BROWSER: 'true',
    TERM_PROGRAM: 'vscode',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    ANTHROPIC_BASE_URL: DEAD,
    MERCURY_CUSTOM_OAUTH_URL: DEAD,
    MERCURY_OPENAI_API_BASE: DEAD,
    MERCURY_OPENAI_CHATGPT_BASE: DEAD,
    MERCURY_OPENAI_AUTH_BASE: DEAD,
    MERCURY_OPENROUTER_API_BASE: DEAD,
    MERCURY_OPENROUTER_AUTH_BASE: DEAD,
    MERCURY_GEMINI_API_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_AUTH_BASE: DEAD,
    MERCURY_GEMINI_OAUTH_TOKEN_BASE: DEAD,
    MERCURY_HUGGINGFACE_API_BASE: DEAD,
    MERCURY_HUGGINGFACE_HUB_BASE: DEAD,
    MERCURY_MOONSHOT_API_BASE: DEAD,
    MERCURY_MOONSHOT_OAUTH_BASE: DEAD,
    MERCURY_MOONSHOT_CODING_BASE: DEAD,
    MERCURY_ZAI_API_BASE: DEAD,
    MERCURY_DEEPSEEK_API_BASE: DEAD,
    MERCURY_UPDATE_API_BASE_URL: DEAD,
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV', 'MERCURY_DEMO', 'TERMINAL_EMULATOR',
    '__CFBundleIdentifier', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
    'MERCURY_DISABLE_1M_CONTEXT', 'MERCURY_CUSTOM_MODEL_OPTION',
  ]) {
    delete env[k]
  }
  return env
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
const driver = resolveCaptureDriver()
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

const home = join(ROOT, 'home')
seedFirstRun(home, [CWD])
writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
const sends: Send[] = [
  { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 3, data: '\r' },
  { atTick: 999, requireAwait: true, awaitText: 'ready · ', minTick: 5, awaitSettleTicks: 3, data: '/model' },
  { afterPrevTicks: 3, data: '\r' },
  { requireAwait: true, awaitText: 'CHOOSE A MODEL', awaitSettleTicks: 8, mark: 'opened', data: DOWN },
  { afterPrevTicks: 2, data: DOWN },
  { afterPrevTicks: 2, data: DOWN },
  { afterPrevTicks: 2, data: DOWN },
  { afterPrevTicks: 5, mark: 'focus', data: 'c' },
  { afterPrevTicks: 6, mark: 'toggled', data: 'c' },
  { afterPrevTicks: 6, mark: 'toggled-back', data: HOME },
  { afterPrevTicks: 6, mark: 'group-top', data: ESC },
]
const out = join(ROOT, 'picker.json')
const cfgPath = join(ROOT, 'picker.cfg.json')
writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols: COLS, rows: ROWS, total: 400, sends, out, title: 'one row per model @120x40' }))

console.log('============================================================')
console.log(' /model lists one row per model; c chooses the window on the row')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}
const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env: childEnv(home), timeout: vshotBudgetMs(400 * 200 + 90_000) })
const marks = new Map<string, string[]>()
if (existsSync(out)) {
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { marks?: Array<{ label: string; grid: Grid }> }
  for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
}
if (FRAMES !== undefined) {
  mkdirSync(FRAMES, { recursive: true })
  for (const [mark, frame] of marks) writeFileSync(join(FRAMES, `one-row-${COLS}x${ROWS}-${mark}.txt`), frame.join('\n') + '\n')
}
if (res.status !== 0) console.log((res.stderr ?? '').trim().split('\n').slice(-8).join('\n'))

const focusLine = (lines: string[]): string => (lines.find(l => l.includes('│ │ ')) ?? '').split('│ │ ')[1]?.replace(/\s+│.*$/, '').trim() ?? ''
const nameOf = (row: string): string => row.split(/\s{2,}/)[0] ?? ''
const windowOf = (row: string): string => /(\d+k|\d+M) ctx/.exec(row)?.[1] ?? ''
const anthropicGroup = (lines: string[]): string[] => {
  const start = lines.findIndex(l => l.includes('MERCURY — ANTHROPIC MODELS'))
  if (start < 0) return []
  const rows: string[] = []
  for (const l of lines.slice(start + 1)) {
    const cell = l.replace(/^\s*│\s?/, '').replace(/\s*│\s*$/, '').trim()
    if (cell.startsWith('MERCURY — ') || cell.startsWith('↓ ') || cell.startsWith('context ') || cell === '') break
    if (cell.startsWith('╭') || cell.startsWith('╰') || cell === 'signed in') continue
    rows.push(cell.replace(/^│\s*/, ''))
  }
  return rows
}

const opened = marks.get('opened') ?? []
const focus = marks.get('focus') ?? []
const toggled = marks.get('toggled') ?? []
const back = marks.get('toggled-back') ?? []
const top = marks.get('group-top') ?? []
check('the drive delivered every send (exit 0)', res.status === 0, `exit ${res.status}`)
check('the picker opened with the current row boxed', opened.some(l => l.includes('CHOOSE A MODEL')) && opened.some(l => l.includes('● current')), opened.filter(l => l.includes('│ │')).join(' | '))
const group = anthropicGroup(top)
const names = group.map(nameOf)
console.log(`  [record] the Anthropic group: ${names.join(' · ')}`)
check('the Anthropic group lists no "(1M context)" row', group.length > 0 && names.every(n => !n.endsWith('(1M context)')), names.join(' · '))
check('no display name repeats in the Anthropic group', names.length > 0 && new Set(names).size === names.length, names.join(' · '))
check('the previous generations with a suffix window (Opus 4.8, 4.7, 4.6) are one row each', ['Opus 4.8', 'Opus 4.7', 'Opus 4.6'].every(n => names.filter(x => x === n).length === 1), names.join(' · '))
check('four ↓ from the current row focus the Opus 4.6 row, its window 1M', nameOf(focusLine(focus)) === 'Opus 4.6' && windowOf(focusLine(focus)) === '1M', focusLine(focus))
check('c keeps the cursor on the row and drops its window to 200k', nameOf(focusLine(toggled)) === 'Opus 4.6' && windowOf(focusLine(toggled)) === '200k', focusLine(toggled))
check('c again brings the window back to 1M on the same row', nameOf(focusLine(back)) === 'Opus 4.6' && windowOf(focusLine(back)) === '1M', focusLine(back))

if (KEEP) console.log(`  [keep] ${ROOT}`)
else rmSync(ROOT, { recursive: true, force: true })
console.log(`\nprove-model-picker-one-row-drive: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
