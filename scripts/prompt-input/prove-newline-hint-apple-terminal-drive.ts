#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const NAME = 'prove-newline-hint-apple-terminal-drive'
if (process.platform !== 'darwin') {
  console.log(`${NAME}: SKIPPED — the drive plays Apple Terminal, which runs on macOS only (this host is ${process.platform})`)
  process.exit(0)
}
const REPO = join(import.meta.dir, '..', '..')
const BIN = process.env.MERCURY_PROOF_BUNDLE ?? join(REPO, 'dist', 'mercury.mjs')
if (!existsSync(BIN)) {
  console.error(`${NAME}: ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`${NAME}: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}
const PYTHON = driver.python
const VSHOT = captureEngineEntry(driver, REPO)

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fixHint ? ` — ${fixHint}` : ''}`)
}

const HINT_FIX = 'getNewlineInstructions and getShortNewlineInstructions in src/screen/composer/composerConfig.ts must name a chord Apple Terminal sends apart from ↵; it sends shift + ↵ as the same CR byte, and it is not among EXTENDED_KEYS_TERMINALS in src/screen/renderer/terminal-session/capabilities.ts'
const DRIVE_FIX = 'the drive through scripts/ui/vshot.py did not reach every step: rebuild dist/mercury.mjs with bun run build.ts and read the frames printed below'
const ADMITTED = 'Type a prompt'
const NEW_LINE = ' new line'
const FIRST = 'line one'
const SECOND = 'line two'
const REPLY = 'FIXTURE-REPLY'
const APPLE_TERMINAL = { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '465', __CFBundleIdentifier: 'com.apple.Terminal' }
const ITERM = { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', __CFBundleIdentifier: 'com.googlecode.iterm2' }
const APPLE_TERMINAL_SENDS = new Map<string, string[]>([
  ['shift+↵', ['\r']],
  ['shift + ↵', ['\r']],
  ['backslash (\\) + ↵', ['\\', '\r']],
  ['\\ ↵', ['\\', '\r']],
  ['\\↵', ['\\', '\r']],
])
const READ_BEFORE_TERM_PROGRAM = ['CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', 'VisualStudioVersion', 'TERMINAL_EMULATOR']
const BOOT = { data: '\r', awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 }
const gate = { requireAwait: true, minTick: 2, awaitSettleTicks: 3 }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'newline-hint-apple-')))
const turn: ScriptedTurn = { kind: 'text', text: REPLY }
const api = await startFixtureApi([turn, turn, turn, turn])

function world(terminal: Record<string, string>, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of READ_BEFORE_TERM_PROGRAM) delete env[key]
  return {
    ...env,
    ...terminal,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_OPERATOR: 'sam',
    MERCURY_REDUCED_MOTION: '1',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_TERMINAL_TITLE: '0',
    ANTHROPIC_BASE_URL: api.url,
    ANTHROPIC_API_KEY: FIXTURE_API_KEY,
    OPENAI_API_KEY: '',
  }
}

const cellText = (cell: unknown): string => (typeof cell === 'object' && cell !== null && 'c' in cell && typeof cell.c === 'string' && cell.c !== '' ? cell.c : ' ')
const rowsOfGrid = (grid: unknown): string[] => (Array.isArray(grid) ? grid.map((row: unknown) => (Array.isArray(row) ? row.map(cellText).join('').trimEnd() : '')) : [])

function marksOf(payload: unknown): Map<string, string[]> {
  const marks = new Map<string, string[]>()
  if (typeof payload !== 'object' || payload === null || !('marks' in payload) || !Array.isArray(payload.marks)) return marks
  const list: unknown[] = payload.marks
  for (const mark of list) {
    if (typeof mark === 'object' && mark !== null && 'label' in mark && typeof mark.label === 'string' && 'grid' in mark) marks.set(mark.label, rowsOfGrid(mark.grid))
  }
  return marks
}

type Drive = { code: number | null; stderr: string; marks: Map<string, string[]>; sent: string[] }

async function drive(label: string, terminal: Record<string, string>, sends: unknown[], readyText: string): Promise<Drive> {
  const leg = join(scratch, label)
  const home = join(leg, 'home')
  const cwd = join(leg, 'project')
  mkdirSync(cwd, { recursive: true })
  seedFirstRun(home, [cwd])
  const out = join(leg, 'grid.json')
  const cfg = join(leg, 'cfg.json')
  writeFileSync(cfg, JSON.stringify({ argv: ['node', BIN], cwd, cols: 120, rows: 40, total: 400, sends, readyText, readySettleTicks: 2, out }))
  const before = api.messageRequests().length
  const stderr: string[] = []
  const code = await new Promise<number | null>(resolve => {
    const child = spawn(PYTHON, [VSHOT, cfg], { cwd, env: world(terminal, home), stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(String(chunk)))
    child.on('error', () => resolve(null))
    child.on('close', exit => {
      clearTimeout(deadline)
      resolve(exit)
    })
  })
  const payload: unknown = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  const sent = api.messageRequests().slice(before).map(request => JSON.stringify(request.body))
  return { code, stderr: stderr.join('').slice(-400), marks: marksOf(payload), sent }
}

const hintRow = (rows: string[]): string => rows.findLast(line => line.includes(NEW_LINE)) ?? ''
const chordOf = (rows: string[]): string => {
  const row = hintRow(rows)
  const seg = row.split(' · ').find(part => part.includes(NEW_LINE)) ?? ''
  if (seg.includes(' for a new line')) return seg.slice(0, seg.indexOf(' for a new line')).trim()
  return seg.includes(NEW_LINE) ? seg.slice(0, seg.indexOf(NEW_LINE)).trim() : ''
}

function composerLines(rows: string[]): string[] {
  const top = rows.findLastIndex(line => line.startsWith('│❯'))
  if (top < 0) return []
  const lines: string[] = []
  for (const row of rows.slice(top)) {
    if (!row.startsWith('│')) break
    lines.push(row.slice(1, row.lastIndexOf('│')).trimEnd())
  }
  return lines
}

function show(label: string, rows: string[]): void {
  console.log(`\n── ${label} ──`)
  for (const row of rows.slice(-8)) console.log(`│${row}`)
}

const spelled = (bytes: string[]): string => bytes.map(data => (data === '\r' ? 'CR' : data === '\\' ? 'backslash' : JSON.stringify(data))).join(', then ')
const carries = (sent: string[], words: string): boolean => sent.some(body => body.includes(words))

console.log('============================================================')
console.log(' the newline hint Apple Terminal shows names a chord it can send')
console.log('============================================================')
console.log(`  bundle: ${BIN}`)
try {
  const rest = await drive('apple-rest', APPLE_TERMINAL, [
    BOOT,
    { ...gate, awaitText: ADMITTED, data: '', mark: 'rest' },
    { ...gate, awaitText: ADMITTED, data: FIRST },
    { ...gate, awaitText: `❯ ${FIRST}`, data: '\r' },
    { ...gate, awaitText: REPLY, data: '', mark: 'sent' },
  ], REPLY)
  const restRows = rest.marks.get('rest') ?? []
  const chord = chordOf(restRows)
  check('Apple Terminal: the drive reached the composer at rest and the turn after CR', rest.code === 0 && rest.marks.has('rest') && rest.marks.has('sent'), `vshot exit ${rest.code}${rest.code === 0 ? '' : ` ${rest.stderr}`}`, DRIVE_FIX)
  check('Apple Terminal: the footer names a chord for a new line', chord !== '', JSON.stringify(hintRow(restRows)), HINT_FIX)
  check('Apple Terminal: the footer does not promise shift+↵ or shift + ↵, which Apple Terminal sends as the same CR as ↵', chord !== 'shift+↵' && chord !== 'shift + ↵', `the footer reads "${hintRow(restRows)}"`, HINT_FIX)
  check('Apple Terminal: CR alone, the byte Apple Terminal sends for shift + ↵ as for ↵, sends the prompt', carries(rest.sent, FIRST), `${rest.sent.length} model request(s) after "${FIRST}" and CR; "${FIRST}" went out: ${carries(rest.sent, FIRST)}`, 'the composer must send its draft on a bare CR; read handleEnter in src/screen/composer/text-input/useTextInput.ts')
  const bytes = APPLE_TERMINAL_SENDS.get(chord)
  check(`Apple Terminal: this proof knows the bytes Apple Terminal sends for "${chord}"`, bytes !== undefined, `known: ${[...APPLE_TERMINAL_SENDS.keys()].join(' · ')}`, 'add the chord and the bytes Apple Terminal sends for it to APPLE_TERMINAL_SENDS in this proof')
  if (bytes !== undefined) {
    const followed = await drive('apple-follow', APPLE_TERMINAL, [
      BOOT,
      { ...gate, awaitText: ADMITTED, data: FIRST },
      ...bytes.map((data, i) => ({ ...gate, awaitText: `❯ ${FIRST}${bytes.slice(0, i).join('')}`, data })),
      { ...gate, awaitText: NEW_LINE, awaitStableTicks: 3, data: SECOND },
      { ...gate, awaitText: SECOND, data: '', mark: 'followed' },
    ], SECOND)
    const followedRows = followed.marks.get('followed') ?? []
    const lines = composerLines(followedRows)
    check('Apple Terminal: the drive that follows the footer reached its last step', followed.code === 0 && followed.marks.has('followed'), `vshot exit ${followed.code}${followed.code === 0 ? '' : ` ${followed.stderr}`}`, DRIVE_FIX)
    check(`Apple Terminal: "${chord}" as Apple Terminal sends it (${spelled(bytes)}) leaves "${FIRST}" and "${SECOND}" as two lines in the composer`, lines.length === 2 && lines[0] === `❯ ${FIRST}` && lines[1]?.trim() === SECOND, `the composer holds ${JSON.stringify(lines)}`, HINT_FIX)
    check(`Apple Terminal: "${chord}" as Apple Terminal sends it sends nothing to the model`, !carries(followed.sent, FIRST), `${followed.sent.length} model request(s); "${FIRST}" went out: ${carries(followed.sent, FIRST)}`, HINT_FIX)
    if (failures > 0) show('Apple Terminal, after following the footer', followedRows)
  }
  if (failures > 0) show('Apple Terminal, at rest', restRows)
  const other = await drive('iterm-rest', ITERM, [
    BOOT,
    { ...gate, awaitText: ADMITTED, data: '', mark: 'rest' },
  ], ADMITTED)
  const otherRows = other.marks.get('rest') ?? []
  check('iTerm.app: the drive reached the composer at rest', other.code === 0 && other.marks.has('rest'), `vshot exit ${other.code}${other.code === 0 ? '' : ` ${other.stderr}`}`, DRIVE_FIX)
  check('iTerm.app, a terminal with extended keys: the idle footer reads "shift+↵ new line"', chordOf(otherRows) === 'shift+↵', JSON.stringify(hintRow(otherRows)), 'iTerm.app is among EXTENDED_KEYS_TERMINALS in src/screen/renderer/terminal-session/capabilities.ts and delivers shift + ↵; getShortNewlineInstructions in src/screen/composer/composerConfig.ts must keep naming shift+↵ there')
  if (chordOf(otherRows) !== 'shift+↵') show('iTerm.app, at rest', otherRows)
} finally {
  await api.close()
  rmSync(scratch, { recursive: true, force: true })
}
console.log(failures === 0 ? `\n${NAME}: green` : `\n${NAME}: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
