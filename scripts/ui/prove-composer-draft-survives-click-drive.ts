#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DIST, FRAMES, argAfter, makeTally } from '../daemon/dupline-world.ts'
import { resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'

const VSHOT = join(import.meta.dir, 'vshot.py')
const tally = makeTally('prove-composer-draft-survives-click-drive')
const KEEP = process.argv.includes('--keep')
const LEGS = new Set((argAfter('--legs') ?? 'doors,concourse').split(','))
const DEAD = 'http://127.0.0.1:9'
const ESC = '\x1b'
const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const BACKSPACE = '\x7f'
const CTRL_T = '\x14'
const CTRL_X = '\x18'
const SHIFT_RIGHT = '\x1b[1;2C'
const CLICK = '\x1b[<0;{X};{Y}M\x1b[<0;{X};{Y}m'
const CLICK_OUTSIDE = '\x1b[<0;90;43M\x1b[<0;90;43m'
const DRAFT = 'the quick brown fox'
const DRAFT_ROW = `│❯ ${DRAFT}`
const CARET_BACK = 4
const PLACEHOLDER = 'Type a prompt'
const COLS = 178
const ROWS = 51

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
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'composer-draft-click-')))

type Cell = string | { c?: string } | null
type Grid = Cell[][]
type Cursor = { x: number; y: number }
type Frame = { text: string; cursor: Cursor }
const cellGlyph = (cell: Cell | undefined): string => (typeof cell === 'object' && cell !== null ? (cell.c ?? ' ') : String(cell ?? ' '))
const gridText = (grid: Grid): string => grid.map(row => row.map(c => cellGlyph(c)).join('')).join('\n')
const rowsOf = (frame: Frame | undefined): string[] => (frame?.text ?? '').split('\n')
const has = (frame: Frame | undefined, needle: string): boolean => (frame?.text ?? '').includes(needle)
const composerRow = (frame: Frame | undefined): string | undefined => rowsOf(frame).find(r => r.startsWith('│❯'))
const cursorOf = (frame: Frame | undefined): string => (frame === undefined ? '(no frame)' : `${frame.cursor.x},${frame.cursor.y}`)

function seedWorld(name: string, settings: Record<string, unknown>): { home: string; cwd: string } {
  const home = join(scratch, `home-${name}`)
  const cwd = join(scratch, `cwd-${name}`, 'fixture-cwd')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(cwd, 'src'), { recursive: true })
  writeFileSync(join(cwd, 'README.md'), '# fixture\n')
  writeFileSync(join(cwd, 'src', 'alpha.ts'), 'export const alpha = 1\n')
  seedFirstRun(home, [cwd])
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ skipSovereignConsentPrompt: true, prefersReducedMotion: true, spinnerTipsEnabled: false, ...settings }, null, 2))
  return { home, cwd }
}

function driveEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_FULLSCREEN: '1',
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
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
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
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

type Capture = { marks: Record<string, Frame>; sends: number; receipts: number; stderr: string; endReason: string; status: number | null }
async function capture(name: string, cfg: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<Capture> {
  const cfgPath = join(scratch, `${name}.cfg.json`)
  const outPath = join(scratch, `${name}.grid.json`)
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, out: outPath }))
  const stderr: string[] = []
  const status = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(PYTHON, [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(420_000))
    child.stderr?.on('data', c => stderr.push(String(c)))
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(deadline)
      resolve(code)
    })
  })
  if (!existsSync(outPath)) throw new Error(`the capture wrote no grid: ${stderr.join('').slice(0, 400)}`)
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; cursor: Cursor; sendReceipts?: unknown[]; marks?: Array<{ label: string; grid: Grid; cursor: Cursor }>; endReason?: string }
  const marks: Record<string, Frame> = {}
  for (const m of payload.marks ?? []) marks[m.label] = { text: gridText(m.grid), cursor: m.cursor }
  marks.final = { text: gridText(payload.grid), cursor: payload.cursor }
  if (FRAMES) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [label, frame] of Object.entries(marks)) writeFileSync(join(FRAMES, `${name}-${label.replace(':', '-')}.txt`), `${frame.text}\n`)
  }
  return { marks, sends: (cfg.sends as unknown[]).length, receipts: payload.sendReceipts?.length ?? 0, stderr: stderr.join(''), endReason: payload.endReason ?? '', status }
}

type Send = Record<string, unknown>
const gated = (data: string, awaitText: string, extra: Send = {}): Send => ({ data, atTick: 999, awaitText, requireAwait: true, minTick: 1, awaitSettleTicks: 3, ...extra })
const after = (data: string, ticks: number, extra: Send = {}): Send => ({ data, afterPrevTicks: ticks, ...extra })
const clickOn = (target: string, dx: number, extra: Send = {}): Send => ({ data: CLICK, atTick: 999, awaitText: target, requireAwait: true, minTick: 1, awaitSettleTicks: 2, targetText: target, targetDx: dx, ...extra })
const secondClickOn = (target: string, dx: number): Send => ({ data: CLICK, afterPrevTicks: 6, targetText: target, targetDx: dx })
const boot = (): Send[] => [
  gated('\r', 'New Session', { minTick: 5, awaitStableTicks: 6, awaitSettleTicks: 4 }),
  gated(ESC + '[I', 'shortcuts', { minTick: 2, awaitSettleTicks: 6 }),
  gated('', '← back', { minTick: 2, awaitSettleTicks: 6, mark: 'land' }),
]
const retype = (): Send => after(RIGHT.repeat(8) + BACKSPACE.repeat(DRAFT.length + 8) + DRAFT + LEFT.repeat(CARET_BACK), 3)
const cfgFor = (cwd: string, sends: Send[], total: number): Record<string, unknown> => ({ cols: COLS, rows: ROWS, total, cwd, argv: ['node', DIST], sends, stableTicks: 4 })
const dueDetail = (cap: Capture): string => `${cap.receipts}/${cap.sends} · status ${cap.status} · end ${cap.endReason} · ${cap.stderr.slice(-300)}`

type Door = {
  name: string
  road: string
  open: Send[]
  needle: string | null
  close: Send | null
}
const header = (name: string, road: string, target: string, needle: string): Door => ({ name, road, open: [clickOn(target, 1)], needle, close: after(ESC, 1) })
const row = (name: string, road: string, target: string, needle: string): Door => ({ name, road, open: [clickOn(target, 2), secondClickOn(target, 2)], needle, close: after(ESC, 1) })
const DOORS: Door[] = [
  header('usage-header', 'USAGE card header → /usage (esc closes)', 'USAGE', 'Mercury · usage'),
  { name: 'usage-header-click-outside', road: 'USAGE card header → /usage (a click outside closes)', open: [clickOn('USAGE', 1)], needle: 'Mercury · usage', close: after(CLICK_OUTSIDE, 1) },
  row('usage-row', 'usage spend row (select, then activate) → /usage', 'spend none yet', 'Mercury · usage'),
  row('ctx-row', 'ctx row (select, then activate) → /deck', 'ctx — ·', 'Mercury — cockpit'),
  header('workflow-header', 'WORKFLOW card header → /workflows', 'WORKFLOW', 'Mercury — workflows'),
  header('trace-header', 'TRACE card header → /trace', 'TRACE ·', 'Mercury — trace'),
  header('console-header', 'CONSOLE card header → /console', 'CONSOLE', 'Mercury — console'),
  header('workbench-header', 'WORKBENCH card header → /workbench', 'WORKBENCH', 'Mercury — prompts'),
  header('files-header', 'FILES card header → /files', 'FILES ·', 'Mercury · files'),
  row('files-row', 'FILES browse row (select, then activate) → /files', 'or click · browse', 'Mercury · files'),
  { name: 'next-row-click', road: 'NEXT /workflows row, two clicks (a keyboard-only row: the pointer is dead here, and tab enters the rails only from an empty prompt)', open: [clickOn('/workflows — agent', 2), secondClickOn('/workflows — agent', 2)], needle: null, close: null },
  { name: 'ctrl-t', road: 'ctrl+t (the task panel toggle; nothing paints with no tasks)', open: [after(CTRL_T, 2)], needle: null, close: after(CTRL_T, 1) },
  { name: 'palette', road: 'ctrl+x p palette, usage, ↵ (an insert at the caret, never a submit)', open: [after(CTRL_X, 2), after('p', 3), after('usage', 3), after('\r', 3)], needle: 'brown/usage', close: null },
  row('health-row', 'HEALTH cert row (select, then activate) → /health', 'no cert · /health', 'Mercury — health'),
  header('health-header', 'HEALTH card header → /health', 'HEALTH', 'Mercury — health'),
]

function doorSends(door: Door): Send[] {
  const sends: Send[] = [retype(), after('', 5, { mark: `${door.name}:typed` }), ...door.open]
  sends.push(door.needle === null ? after('', 12, { mark: `${door.name}:open` }) : gated('', door.needle, { awaitSettleTicks: 6, mark: `${door.name}:open` }))
  if (door.close !== null) sends.push(door.close)
  sends.push(after('', 12, { mark: `${door.name}:closed` }))
  return sends
}

function judge(tag: string, door: Door, m: Record<string, Frame>): void {
  const typed = m[`${door.name}:typed`]
  const open = m[`${door.name}:open`]
  const closed = m[`${door.name}:closed`]
  const typedRow = composerRow(typed) ?? ''
  const openRow = composerRow(open)
  const closedRow = composerRow(closed) ?? '(no composer row)'
  tally.section(`${tag} · ${door.road}`)
  tally.check(`${door.name} T1 the draft was typed with the caret ${CARET_BACK} cells before its end`, typedRow.startsWith(DRAFT_ROW) && typed?.cursor.x === 3 + DRAFT.length - CARET_BACK, `${typedRow.trimEnd() || '(no composer row)'} · caret ${cursorOf(typed)}`)
  if (door.needle !== null) tally.check(`${door.name} T2 the door opened its surface`, has(open, door.needle), rowsOf(open).filter(r => r.includes('Mercury')).join(' | ') || '(no surface)')
  if (door.name === 'next-row-click') tally.check(`${door.name} T2 two clicks opened nothing (the row has no pointer road) and moved no rail caret onto it`, !has(open, 'Mercury —') && !rowsOf(open).some(r => r.includes('❯ · /workflows')), rowsOf(open).filter(r => r.includes('/workflows')).join(' | '))
  if (door.name === 'ctrl-t') tally.check(`${door.name} T2 the frame outside the composer is unchanged by ctrl+t (no task panel paints with no tasks)`, open !== undefined && typed !== undefined && open.text === typed.text, 'the frames differ')
  if (door.name === 'palette') tally.check(`${door.name} T3 the pick inserted /usage at the caret and kept every character of the draft; nothing ran`, openRow !== undefined && openRow.startsWith(`│❯ ${DRAFT.slice(0, DRAFT.length - CARET_BACK)}/usage ${DRAFT.slice(DRAFT.length - CARET_BACK)}`) && !has(open, 'Mercury · usage'), openRow?.trimEnd() ?? '(no composer row)')
  else if (openRow !== undefined) tally.check(`${door.name} T3 under the surface the composer still reads the draft, not the placeholder`, openRow.startsWith(DRAFT_ROW) && !openRow.includes(PLACEHOLDER), openRow.trimEnd())
  else tally.check(`${door.name} T3 the surface covers the composer row (nothing to read under it)`, true)
  if (door.name === 'palette') return
  if (door.needle !== null) tally.check(`${door.name} T4 the surface closed`, !has(closed, door.needle), rowsOf(closed).filter(r => r.includes(door.needle as string)).join(' | '))
  tally.check(`${door.name} T5 after the surface closed the composer reads the draft as typed`, closedRow === typedRow, `${closedRow.trimEnd()}${closedRow === typedRow ? '' : `\n    typed: ${typedRow.trimEnd()}`}`)
  tally.check(`${door.name} T6 the caret is back where it was`, closed !== undefined && typed !== undefined && closed.cursor.x === typed.cursor.x && closed.cursor.y === typed.cursor.y, `caret ${cursorOf(closed)}, typed ${cursorOf(typed)}`)
}

async function doorsLeg(): Promise<void> {
  const { home, cwd } = seedWorld('doors', {})
  const sends = [...boot(), ...DOORS.flatMap(doorSends)]
  const cap = await capture('doors-178x51', cfgFor(cwd, sends, 1500), driveEnv(home))
  const m = cap.marks
  tally.section('doors 178x51 · every click door over a typed draft, one boot')
  tally.check('doors D1 every send became due (every door opened what it names)', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
  tally.check('doors D2 the chat landed on an empty composer', has(m.land, PLACEHOLDER), composerRow(m.land)?.trimEnd() ?? '(no composer row)')
  for (const door of DOORS) judge('doors 178x51', door, m)
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

async function concourseLeg(): Promise<void> {
  const { home, cwd } = seedWorld('concourse', { sessionsBar: true })
  const door: Door = { name: 'concourse-chip', road: 'SESSIONS bar concourse chip → /concourse (⇧→ returns to the chat)', open: [clickOn('SESSIONS ›', 2)], needle: 'SESSION CONCOURSE', close: after(SHIFT_RIGHT, 1) }
  const cap = await capture('concourse-178x51', cfgFor(cwd, [...boot(), ...doorSends(door)], 500), driveEnv(home))
  const m = cap.marks
  tally.section('concourse 178x51 · the SESSIONS bar chip over a typed draft')
  tally.check('concourse C1 every send became due', cap.receipts === cap.sends && cap.status === 0, dueDetail(cap))
  tally.check('concourse C2 the SESSIONS bar is on the chat', has(m.land, 'SESSIONS ›'), rowsOf(m.land).filter(r => r.includes('SESSIONS')).join(' | '))
  judge('concourse 178x51', door, m)
  if (KEEP) console.log(`world kept: ${home} ${cwd}`)
}

if (LEGS.has('doors')) await doorsLeg()
if (LEGS.has('concourse')) await concourseLeg()

if (tally.failed() === 0 && !KEEP) rmSync(scratch, { recursive: true, force: true })
else console.log(`scratch kept: ${scratch}`)
tally.finish()
