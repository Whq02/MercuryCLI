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
const KEEP = process.argv.includes('--keep')
const VSHOT = join(import.meta.dir, 'vshot.py')
const KEY = 'proof-key-ci-gate-not-a-real-key'
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const DOWN = `${ESC}[B`
const COLS = 178
const ROWS = 51
const TITLE = 'Mercury · model'
const COMPOSER = 'Type a prompt'
const KEYS = '↑↓ select'
const FACE_HINT = '↑↓ choose'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 500)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

process.env.ANTHROPIC_API_KEY = KEY
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'picker-popup-drive-')))
const CWD = join(ROOT, 'fixture-cwd')
mkdirSync(join(CWD, '.mercury'), { recursive: true })
writeFileSync(join(CWD, 'README.md'), 'a fixture folder\n')
const NODE = existsSync(join(dirname(BIN), 'vendor', 'node', 'bin', 'node')) ? join(dirname(BIN), 'vendor', 'node', 'bin', 'node') : 'node'
if (FRAMES) mkdirSync(FRAMES, { recursive: true })

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
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_HEALTH_STATE_DIR: join(home, 'health-state'),
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREWS_DIR: join(home, 'crews'),
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
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
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
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  writeFileSync(
    join(home, 'critter-profile.json'),
    JSON.stringify({ v: 1, seed: '00000000-0000-4000-8000-00000000c0de', createdAt: 1787600000000, milestones: { settles: 0, recoveries: 0 }, quiet: true, seenTips: {}, openedSurfaces: [] }),
  )
  return home
}

type Send = Record<string, unknown>
type Grid = Array<Array<{ c: string }>>
type Capture = { status: number | null; stderr: string; lines: string[]; marks: Map<string, string[]>; receipts: number }

const driver = resolveCaptureDriver()
const textOf = (grid: Grid): string[] => grid.map(row => row.map(cell => cell.c).join(''))

function capture(id: string, home: string, sends: Send[], opts: { total: number; ready: string[] }): Capture {
  if (driver.kind !== 'posix-pty') throw new Error(`no POSIX pty capture driver on this host (${driver.kind})`)
  const out = join(ROOT, `${id}.json`)
  const cfgPath = join(ROOT, `${id}.cfg.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({ argv: [NODE, BIN], cwd: CWD, cols: COLS, rows: ROWS, total: opts.total, readySettleTicks: 4, stableTicks: 3, sends, readyText: opts.ready, out }),
  )
  const res = spawnSync(driver.python, [VSHOT, cfgPath], { encoding: 'utf-8', env: childEnv(home), timeout: vshotBudgetMs(opts.total * 200 + 90_000) })
  const marks = new Map<string, string[]>()
  let lines: string[] = []
  let receipts = 0
  if (existsSync(out)) {
    const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid?: Grid; marks?: Array<{ label: string; grid: Grid }>; sendReceipts?: unknown[] }
    if (payload.grid) lines = textOf(payload.grid)
    for (const m of payload.marks ?? []) marks.set(m.label, textOf(m.grid))
    receipts = payload.sendReceipts?.length ?? 0
  }
  if (res.status !== 0) {
    console.log(`  ── ${id}: vshot exit ${res.status} ──`)
    for (const row of lines) console.log('  │' + row.replace(/\s+$/, ''))
    console.log((res.stderr ?? '').trim().split('\n').slice(-8).join('\n'))
  }
  return { status: res.status, stderr: res.stderr ?? '', lines, marks, receipts }
}

type Window = { top: number; bottom: number; left: number; right: number; width: number; height: number; rows: string[] }

function windowOf(lines: string[]): Window | null {
  const titleRow = lines.findIndex(line => line.includes(TITLE))
  if (titleRow < 0) return null
  const cells = Array.from(lines[titleRow]!)
  const titleAt = lines[titleRow]!.indexOf(TITLE)
  const left = cells.lastIndexOf('│', titleAt)
  if (left < 0) return null
  let top = -1
  for (let y = titleRow; y >= 0; y--) {
    if (Array.from(lines[y]!)[left] === '╭') { top = y; break }
  }
  if (top < 0) return null
  const right = Array.from(lines[top]!).indexOf('╮', left + 1)
  if (right < 0) return null
  let bottom = -1
  for (let y = top + 1; y < lines.length; y++) {
    if (Array.from(lines[y]!)[left] === '╰') { bottom = y; break }
  }
  if (bottom < 0) return null
  const rows = lines.slice(top, bottom + 1).map(line => Array.from(line).slice(left, right + 1).join(''))
  return { top, bottom, left, right, width: right - left + 1, height: bottom - top + 1, rows }
}
const inner = (row: string): string => Array.from(row).slice(2, -2).join('').replace(/\s+$/, '')
const describe = (window: Window | null): string => (window === null ? 'no closed window' : `left ${window.left} · top ${window.top} · width ${window.width} · height ${window.height} (rows ${window.top}..${window.bottom})`)
const trimmedRow = (lines: string[], needle: string): string => (lines.find(l => l.includes(needle)) ?? '').trim()
const save = (name: string, lines: string[]): void => {
  if (!FRAMES) return
  writeFileSync(join(FRAMES, `${name}-${COLS}x${ROWS}.txt`), lines.map(line => line.replace(/\s+$/, '')).join('\n') + '\n')
}

console.log('============================================================')
console.log(' the model picker in a session is the pop-up the Boot face draws')
console.log(`   bundle: ${BIN}`)
console.log('============================================================')
if (!existsSync(BIN)) {
  console.error('  dist/mercury.mjs missing — bun run build.ts first')
  process.exit(1)
}

section(`§1 ${COLS}x${ROWS}: m on the Boot face, then /model in the chat born from it — one window`)
{
  const home = seededHome('popup')
  const downs: Send[] = Array.from({ length: 8 }, () => ({ afterPrevTicks: 1, data: DOWN.repeat(5) }))
  const sends: Send[] = [
    { atTick: 999, requireAwait: true, awaitText: FACE_HINT, minTick: 3, awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'face', data: 'm' },
    { requireAwait: true, awaitText: TITLE, awaitStableTicks: 3, mark: 'face-picker', data: ESC },
    { requireAwait: true, awaitText: FACE_HINT, awaitSettleTicks: 3, mark: 'face-closed', data: '\r' },
    { atTick: 999, requireAwait: true, awaitText: '← back', minTick: 5, awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'chat', data: '/model' },
    { afterPrevTicks: 2, data: '\r' },
    { requireAwait: true, awaitText: TITLE, awaitStableTicks: 3, mark: 'session-picker', data: '' },
    ...downs,
    { afterPrevTicks: 3, awaitText: '↑ ', awaitStableTicks: 3, mark: 'scrolled', data: ESC },
    { afterPrevTicks: 5, data: '', mark: 'closed' },
  ]
  const c = capture('popup', home, sends, { total: 420, ready: [COMPOSER] })
  check('the drive delivered every send (exit 0)', c.status === 0 && c.receipts === sends.length, `exit ${c.status} · ${c.receipts}/${sends.length} sends`)
  const face = c.marks.get('face-picker') ?? []
  const chat = c.marks.get('chat') ?? []
  const session = c.marks.get('session-picker') ?? []
  const scrolled = c.marks.get('scrolled') ?? []
  const closed = c.marks.get('closed') ?? []
  save('boot-face-picker', face)
  save('session-picker', session)
  save('session-picker-scrolled', scrolled)
  save('session-picker-closed', closed)
  const faceWindow = windowOf(face)
  const sessionWindow = windowOf(session)
  const scrolledWindow = windowOf(scrolled)
  console.log(`  Boot face window: ${describe(faceWindow)}`)
  console.log(`  session window:   ${describe(sessionWindow)}`)
  console.log(`  scrolled window:  ${describe(scrolledWindow)}`)
  check('m opens the picker over the Boot face as one closed bordered window', faceWindow !== null, face.slice(2, 6).join(' | '))
  check('esc closes it back to the face', (c.marks.get('face-closed') ?? []).some(l => l.includes(FACE_HINT)) && !(c.marks.get('face-closed') ?? []).some(l => l.includes(TITLE)))
  check('the chat landed with its composer', chat.some(l => l.includes(COMPOSER)) && trimmedRow(chat, '← back') !== '', chat.slice(-6).join(' | '))
  check('/model opens the picker in the session as one closed bordered window', sessionWindow !== null, session.slice(-8).join(' | '))
  const sheetRule = session.findIndex(line => /^▔+$/.test(line.trim()) && line.trim().length >= COLS - 2)
  check('no full-width sheet rule crosses the terminal', sheetRule < 0, `rule at row ${sheetRule}`)
  check('the composer stays on screen under the picker', session.some(l => l.includes(COMPOSER)), 'the composer placeholder is not on screen')
  check('the lanes rail stays on screen beside the picker', session.some(l => l.includes('lanes')), session.slice(0, 4).join(' | '))
  if (faceWindow !== null && sessionWindow !== null) {
    check(`the window's left edge equals the Boot face's (${faceWindow.left})`, sessionWindow.left === faceWindow.left, `session ${sessionWindow.left}`)
    check(`the window's top row equals the Boot face's (${faceWindow.top})`, sessionWindow.top === faceWindow.top, `session ${sessionWindow.top}`)
    check(`the window's width equals the Boot face's (${faceWindow.width})`, sessionWindow.width === faceWindow.width, `session ${sessionWindow.width}`)
    const viewLeft = Array.from(session[0] ?? '').indexOf('╭')
    const viewBottom = session.findIndex((line, row) => row > 0 && Array.from(line)[viewLeft] === '╰')
    check(`the window ends above the view's bottom border (row ${viewBottom})`, viewBottom > 0 && sessionWindow.bottom < viewBottom, `window bottom ${sessionWindow.bottom}`)
    check('the keys row is the window\'s last inner row', inner(sessionWindow.rows[sessionWindow.height - 2]!).startsWith(KEYS), inner(sessionWindow.rows[sessionWindow.height - 2]!))
    const firstRow = inner(sessionWindow.rows[3]!)
    check('↓ past the last visible row keeps the window in place', scrolledWindow !== null && scrolledWindow.top === sessionWindow.top && scrolledWindow.left === sessionWindow.left && scrolledWindow.width === sessionWindow.width && scrolledWindow.height === sessionWindow.height, describe(scrolledWindow))
    check('the rows scroll inside the window (a ↑ more line leads and the first row changed)', scrolledWindow !== null && scrolledWindow.rows.some(row => /↑ \d+ more/.test(row)) && inner(scrolledWindow.rows[3]!) !== firstRow, scrolledWindow === null ? '' : scrolledWindow.rows.slice(1, 5).map(inner).join(' | '))
    check('the footer stays the window\'s last inner row while the rows scroll', scrolledWindow !== null && inner(scrolledWindow.rows[scrolledWindow.height - 2]!).startsWith(KEYS), scrolledWindow === null ? '' : inner(scrolledWindow.rows[scrolledWindow.height - 2]!))
  }
  check('esc closes the picker and the chat stands as it was', !closed.some(l => l.includes(TITLE)) && closed.some(l => l.includes(COMPOSER)) && trimmedRow(closed, '← back') !== '', closed.slice(-6).join(' | '))
}

if (!KEEP) rmSync(ROOT, { recursive: true, force: true })
else console.log(`worlds kept at ${ROOT}`)
console.log('\n' + '='.repeat(60))
console.log(`${checks} checks, ${failures} failures`)
console.log(failures === 0 ? ' the session picker is the Boot face\'s pop-up' : ` picker pop-up drive — ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
