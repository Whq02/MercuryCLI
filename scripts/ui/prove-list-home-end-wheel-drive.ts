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
const CASE = argAfter('--case')
const VSHOT = join(import.meta.dir, 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const DOWN = `${ESC}[B`
const HOME = `${ESC}[H`
const END = `${ESC}[F`
const TAB = '\t'
const WHEEL_DOWN = `${ESC}[<65;40;20M`
const WHEEL_UP = `${ESC}[<64;40;20M`
const COLS = 120
const ROWS = 40
const KEEP = process.env.LIST_KEYS_KEEP === '1'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 400)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'list-home-end-wheel-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CRITTER: 'clam',
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
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
  }
  for (const k of [
    'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_OAUTH_TOKEN', 'NODE_ENV', 'MERCURY_DEMO', 'TERMINAL_EMULATOR',
    '__CFBundleIdentifier', 'MERCURY_MODEL', 'MERCURY_DEFAULT_FABLE_MODEL', 'MERCURY_DEFAULT_OPUS_MODEL', 'MERCURY_DEFAULT_SONNET_MODEL',
  ]) {
    delete env[k]
  }
  return env
}

function seededHome(tag: string): string {
  const home = join(ROOT, `home-${tag}`)
  seedFirstRun(home, [CWD])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ prefersReducedMotion: true, spinnerTipsEnabled: false }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  return home
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
type Capture = { status: number | null; stderr: string; lines: string[]; marks: Map<string, string[]> }

const driver = resolveCaptureDriver()
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

function capture(id: string, home: string, sends: Send[], total: number): Capture {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const out = join(ROOT, `${id}.json`)
  const cfgPath = join(ROOT, `${id}.cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols: COLS, rows: ROWS, total, readySettleTicks: 4, stableTicks: 3, sends, readyText: ['Type a prompt'], out }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env: childEnv(home), timeout: vshotBudgetMs(total * 200 + 90_000) })
  const marks = new Map<string, string[]>()
  let lines: string[] = []
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }> }
    if (payload.grid) lines = textOf(payload.grid)
    for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
  }
  if (res.status !== 0) {
    console.log(`  ── ${id}: vshot exit ${res.status} ──`)
    for (const row of lines) console.log('  │' + row.replace(/\s+$/, ''))
    console.log((res.stderr ?? '').trim().split('\n').slice(-8).join('\n'))
  }
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [mark, frame] of marks) writeFileSync(join(FRAMES, `${id}-${COLS}x${ROWS}-${mark}.txt`), frame.join('\n') + '\n')
  }
  return { status: res.status, stderr: res.stderr ?? '', lines, marks }
}

const enterChat: Send[] = [
  { atTick: 999, requireAwait: true, awaitText: '↑↓ choose', minTick: 3, awaitSettleTicks: 2, data: '\r' },
]

console.log('============================================================')
console.log(' Home, End and the mouse wheel over a list with hidden rows')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

const focusBoxRow = (lines: string[]): number => lines.findIndex(l => l.includes('│ │ '))
const outsideOf = (lines: string[], left: number): string => lines.map(l => l.slice(0, left)).join('\n')

if (CASE === undefined || CASE === 'picker') {
  section('the /model picker: the wheel moves the highlight, End and Home reach the ends, the chat beneath stays')
  const home = seededHome('picker')
  const c = capture('picker', home, [
    ...enterChat,
    { atTick: 999, requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 2, data: '/model' },
    { afterPrevTicks: 3, data: '\r' },
    { requireAwait: true, awaitText: '│ │ ', awaitStableTicks: 3, mark: 'picker', data: WHEEL_DOWN },
    { afterPrevTicks: 3, data: WHEEL_DOWN },
    { afterPrevTicks: 5, data: '', mark: 'wheeled' },
    { afterPrevTicks: 1, data: WHEEL_UP },
    { afterPrevTicks: 5, data: '', mark: 'wheeled-back' },
    { afterPrevTicks: 1, data: END },
    { afterPrevTicks: 5, data: '', mark: 'end' },
    { afterPrevTicks: 1, data: HOME },
    { afterPrevTicks: 5, data: '', mark: 'home' },
    { afterPrevTicks: 2, data: ESC },
  ], 140)
  check('the drive delivered every send', c.status === 0, `exit ${c.status}`)
  const picker = c.marks.get('picker') ?? []
  const wheeled = c.marks.get('wheeled') ?? []
  const back = c.marks.get('wheeled-back') ?? []
  const end = c.marks.get('end') ?? []
  const homeF = c.marks.get('home') ?? []
  check('the picker opened with a focus box', picker.some(l => l.includes('CHOOSE A MODEL')) && focusBoxRow(picker) >= 0, picker.slice(2, 8).join(' | '))
  const left = Math.max(0, picker.findIndex(l => l.includes('╭')) >= 0 ? (picker.find(l => l.includes('╭')) ?? '').indexOf('╭') : 0)
  const r0 = focusBoxRow(picker)
  const r1 = focusBoxRow(wheeled)
  const r2 = focusBoxRow(back)
  console.log(`  [record] focus box row: opened ${r0} · after two wheel notches down ${r1} · after one notch up ${r2} · End ${focusBoxRow(end)} · Home ${focusBoxRow(homeF)}`)
  const moreAbove = (lines: string[]): boolean => lines.some(l => /↑ \d+ more/.test(l))
  const moreBelow = (lines: string[]): boolean => lines.some(l => /↓ \d+ more/.test(l))
  check('the picker opened past its first rows (rows folded above the window)', moreAbove(picker), 'no fold marker above')
  check('two wheel notches down move the highlight down the picker', r0 >= 0 && r1 > r0, `row ${r0} → ${r1}`)
  check('one notch up brings it back up one row', r1 > r2 && r2 > r0, `row ${r1} → ${r2}`)
  check('the columns left of the picker (the chat beneath) are unchanged by the wheel', outsideOf(picker, left) === outsideOf(wheeled, left))
  check('End moves the highlight to the last row (the window at the tail, nothing folded below)', focusBoxRow(end) > r0 && !moreBelow(end), `row ${focusBoxRow(end)}; folded below: ${moreBelow(end)}`)
  check('Home returns the highlight to the first row (the window at the head, nothing folded above)', focusBoxRow(homeF) >= 0 && focusBoxRow(homeF) < r0 && !moreAbove(homeF), `row ${focusBoxRow(homeF)}; folded above: ${moreAbove(homeF)}`)
}

if (CASE === undefined || CASE === 'help') {
  section('the /help commands list (a Select with hidden rows): End, Home and the wheel')
  const home = seededHome('help')
  const c = capture('help', home, [
    ...enterChat,
    { atTick: 999, requireAwait: true, awaitText: 'Type a prompt', minTick: 5, awaitSettleTicks: 2, data: '/help' },
    { afterPrevTicks: 3, data: '\r' },
    { requireAwait: true, awaitText: 'commands', awaitStableTicks: 3, data: TAB },
    { requireAwait: true, awaitText: 'Browse default commands', awaitStableTicks: 3, data: DOWN },
    { afterPrevTicks: 5, data: '', mark: 'list' },
    { afterPrevTicks: 1, data: END },
    { afterPrevTicks: 5, data: '', mark: 'end' },
    { afterPrevTicks: 1, data: HOME },
    { afterPrevTicks: 5, data: '', mark: 'home' },
    { afterPrevTicks: 1, data: WHEEL_DOWN },
    { afterPrevTicks: 3, data: WHEEL_DOWN },
    { afterPrevTicks: 5, data: '', mark: 'wheeled' },
    { afterPrevTicks: 2, data: ESC },
  ], 140)
  check('the drive delivered every send', c.status === 0, `exit ${c.status}`)
  const list = c.marks.get('list') ?? []
  const end = c.marks.get('end') ?? []
  const homeF = c.marks.get('home') ?? []
  const wheeled = c.marks.get('wheeled') ?? []
  const pointerRow = (lines: string[]): string => (lines.find(l => /❯\s*\/\S+/.test(l)) ?? '').trim()
  const commandAt = (row: string): string => /❯\s*(\/\S+)/.exec(row)?.[1] ?? ''
  console.log(`  [record] focused command: list ${commandAt(pointerRow(list))} · End ${commandAt(pointerRow(end))} · Home ${commandAt(pointerRow(homeF))} · wheeled ${commandAt(pointerRow(wheeled))}`)
  check('the commands list opened with the cursor on its first command', list.some(l => l.includes('Browse default commands')) && commandAt(pointerRow(list)) !== '', list.slice(4, 12).join(' | '))
  const first = commandAt(pointerRow(list))
  check('End moves the cursor to the last command (a row the opening window did not show)', commandAt(pointerRow(end)) !== '' && commandAt(pointerRow(end)) !== first && !list.some(l => l.includes(` ${commandAt(pointerRow(end))} `)), commandAt(pointerRow(end)))
  check('Home returns the cursor to the first command', commandAt(pointerRow(homeF)) === first, `${commandAt(pointerRow(homeF))} vs ${first}`)
  const commandRows = list.map(l => /^\s*│\s*[❯↓↑]?\s*(\/\S+)\s*│?\s*$/.exec(l)?.[1] ?? '').filter(name => name !== '')
  check('two wheel notches down move the cursor two commands down', commandRows.length > 2 && commandAt(pointerRow(wheeled)) === commandRows[2], `${first} → ${commandAt(pointerRow(wheeled))} (rows: ${commandRows.slice(0, 4).join(' ')})`)
  const rowOf = (lines: string[], needle: string): number => lines.findIndex(l => l.includes(needle))
  check('the wheel moved the cursor, not the panel: the title row stays where it was', rowOf(wheeled, 'Browse default commands') === rowOf(list, 'Browse default commands'), `${rowOf(list, 'Browse default commands')} → ${rowOf(wheeled, 'Browse default commands')}`)
}

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`  kept: ${ROOT}`)
console.log(failures === 0 ? '\n✅ Home, End and the wheel act in the lists on the built product' : `\n❌ ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
