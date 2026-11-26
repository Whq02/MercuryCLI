#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { FIXTURE_API_KEY, seedFirstRun } from '../lib/firstRunSeed.ts'
import { startFixtureApi, type ScriptedTurn } from '../lib/fixtureApi.ts'

const NAME = 'prove-concourse-newline-hint-apple-terminal-drive'
if (process.platform !== 'darwin') {
  console.log(`${NAME}: SKIPPED — the drive plays Apple Terminal, which runs on macOS only (this host is ${process.platform})`)
  process.exit(0)
}
const REPO = join(import.meta.dir, '..', '..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}
const BIN = process.env.MERCURY_PROOF_BUNDLE ?? join(REPO, 'dist', 'mercury.mjs')
const FRAMES = argAfter('--frames')
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
let checks = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fixHint ? ` — ${fixHint}` : ''}`)
}

const HINT_FIX = 'ConcourseStrips.tsx and controlManifest.ts must check getShortNewlineInstructions() from src/screen/composer/composerConfig.ts and show ⌃j newline where shift+↵ cannot be sent'
const DRIVE_FIX = 'the drive through scripts/ui/vshot.py did not reach every step: rebuild dist/mercury.mjs with bun run build.ts and inspect the captured rows'
const ADMITTED = 'Type a prompt'
const SHIFT_LEFT = '\x1b[1;2D'
const TAB = '\t'
const CTRL_J = '\x0a'
const FIRST = 'board line one'
const SECOND = 'board line two'
const REPLY = 'FIXTURE-REPLY'
const APPLE_TERMINAL = { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '465', __CFBundleIdentifier: 'com.apple.Terminal' }
const ITERM = { TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', __CFBundleIdentifier: 'com.googlecode.iterm2' }
const READ_BEFORE_TERM_PROGRAM = ['CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', 'VisualStudioVersion', 'TERMINAL_EMULATOR']
const BOOT = { data: '\r', awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, requireAwait: true, minTick: 10, awaitStableTicks: 6, awaitSettleTicks: 4 }
const gate = { requireAwait: true, minTick: 2, awaitSettleTicks: 3 }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'concourse-newline-apple-')))
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
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    MERCURY_BOOT_PREFLIGHT: '0',
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
  writeFileSync(join(home, 'settings.json'), JSON.stringify({ view: { reducedMotion: true }, activity: { tips: { enabled: false } } }))
  const out = join(leg, 'grid.json')
  const cfg = join(leg, 'cfg.json')
  writeFileSync(cfg, JSON.stringify({ argv: ['node', BIN], cwd, cols: 120, rows: 40, total: 450, sends, readyText, readySettleTicks: 2, out }))
  const before = api.messageRequests().length
  const stderr: string[] = []
  const code = await new Promise<number | null>(resolve => {
    const child = spawn(PYTHON, [VSHOT, cfg], { cwd, env: world(terminal, home), stdio: ['ignore', 'ignore', 'pipe'] })
    const deadline = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(180_000))
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

const carries = (sent: string[], words: string): boolean => sent.some(body => body.includes(words))

console.log('============================================================')
console.log(' the Session Manager newline hint names ⌃j in Apple Terminal and ⇧↵ in iTerm')
console.log('============================================================')
console.log(`  bundle: ${BIN}`)
try {
  const apple = await drive('apple', APPLE_TERMINAL, [
    BOOT,
    { ...gate, awaitText: ADMITTED, data: SHIFT_LEFT },
    { ...gate, awaitText: 'Status & title', data: '?' },
    { ...gate, awaitText: 'CONCOURSE — keys', data: '\x1b', mark: 'atlas' },
    { ...gate, awaitText: 'Status & title', awaitPattern: '\\A(?![\\s\\S]*CONCOURSE — keys)', data: TAB },
    { ...gate, awaitText: '↵↵ enter session', data: FIRST },
    { ...gate, awaitText: FIRST, data: '', mark: 'draft' },
    { ...gate, awaitText: FIRST, data: CTRL_J },
    { ...gate, awaitText: FIRST, awaitStableTicks: 3, data: SECOND },
    { ...gate, awaitText: SECOND, data: '', mark: 'two-lines' },
  ], SECOND)
  const appleDraft = apple.marks.get('draft') ?? []
  const appleTwo = apple.marks.get('two-lines') ?? []
  const appleAtlas = apple.marks.get('atlas') ?? []
  if (FRAMES !== undefined && appleDraft.length > 0) {
    mkdirSync(FRAMES, { recursive: true })
    writeFileSync(join(FRAMES, 'apple-draft-120x40.txt'), appleDraft.join('\n') + '\n')
    writeFileSync(join(FRAMES, 'apple-atlas-120x40.txt'), appleAtlas.join('\n') + '\n')
  }
  const appleFoot = appleDraft.find(l => l.includes('↵ send ·')) ?? ''
  const appleLegend = (appleDraft[appleDraft.length - 1] ?? '').trim()
  const appleAtlasNewline = appleAtlas.find(l => l.includes('newline')) ?? ''
  check('Apple Terminal: the drive reached every step', apple.code === 0 && apple.marks.has('draft') && apple.marks.has('two-lines') && apple.marks.has('atlas'), `vshot exit ${apple.code}${apple.code === 0 ? '' : ` ${apple.stderr}`}`, DRIVE_FIX)
  check('Apple Terminal: live composer foot names ⌃j newline (no ⇧↵)', appleFoot.includes('⌃j newline') && !appleFoot.includes('⇧↵'), appleFoot.trim(), HINT_FIX)
  check('Apple Terminal: board bottom legend names ⌃j newline (no ⇧↵)', appleLegend.includes('⌃j newline') && !appleLegend.includes('⇧↵'), appleLegend, HINT_FIX)
  check('Apple Terminal: ? key atlas names ⌃j newline (no ⇧↵)', appleAtlasNewline.includes('⌃j') && !appleAtlasNewline.includes('⇧↵'), appleAtlasNewline.trim(), HINT_FIX)
  check('Apple Terminal: pressing ⌃j then typing leaves both lines in the composer and sends nothing', appleTwo.some(l => l.includes(FIRST)) && appleTwo.some(l => l.includes(SECOND)) && !carries(apple.sent, FIRST), `sent=${apple.sent.length}`, HINT_FIX)

  const iterm = await drive('iterm', ITERM, [
    BOOT,
    { ...gate, awaitText: ADMITTED, data: SHIFT_LEFT },
    { ...gate, awaitText: 'Status & title', data: TAB },
    { ...gate, awaitText: '↵↵ enter session', data: FIRST },
    { ...gate, awaitText: FIRST, data: '', mark: 'draft' },
  ], FIRST)
  const itermDraft = iterm.marks.get('draft') ?? []
  const itermFoot = itermDraft.find(l => l.includes('↵ send ·')) ?? ''
  const itermLegend = (itermDraft[itermDraft.length - 1] ?? '').trim()
  check('iTerm.app: the drive reached the live composer with a draft', iterm.code === 0 && iterm.marks.has('draft'), `vshot exit ${iterm.code}${iterm.code === 0 ? '' : ` ${iterm.stderr}`}`, DRIVE_FIX)
  check('iTerm.app: live composer foot keeps ⇧↵ newline', itermFoot.includes('⇧↵ newline'), itermFoot.trim(), HINT_FIX)
  check('iTerm.app: board bottom legend keeps ⇧↵/⌃j newline', itermLegend.includes('⇧↵/⌃j newline'), itermLegend, HINT_FIX)
} finally {
  await api.close()
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${NAME}: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
