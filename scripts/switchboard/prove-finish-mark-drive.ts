#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'mercury-finishmark-')))
const TEMPLATE = join(SCRATCH, 'home-template')
const CWD = join(SCRATCH, 'proj-p')
const OTHER = join(SCRATCH, 'proj-q')
mkdirSync(TEMPLATE, { recursive: true })
mkdirSync(CWD, { recursive: true })
mkdirSync(OTHER, { recursive: true })
process.env.MERCURY_CONFIG_DIR = TEMPLATE
process.env.ANTHROPIC_API_KEY = 'fixture-key-000'
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.BROWSER = '/usr/bin/true'
delete process.env.NODE_ENV
delete process.env.CI
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_CONCOURSE

const REPO = join(import.meta.dir, '..', '..')
const binArg = process.argv.find(a => a.startsWith('--bin='))
const BIN = binArg !== undefined ? binArg.slice('--bin='.length) : join(REPO, 'dist', 'mercury.mjs')
const framesArg = process.argv.find(a => a.startsWith('--frames='))
const FRAMES = framesArg !== undefined ? framesArg.slice('--frames='.length) : null
if (FRAMES !== null) mkdirSync(FRAMES, { recursive: true })
if (!existsSync(BIN)) {
  console.error(`✗ ${BIN} missing — run \`bun run build.ts\` first`)
  process.exit(1)
}

const { seedFirstRun } = await import('../lib/firstRunSeed.ts')
const { resolveCaptureDriver, vshotBudgetMs } = await import('../lib/captureDriver.ts')
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { encodeSeedTranscript } = await import('../lib/seedTranscript.ts')
const { readSessionWorkers } = await import('../../src/daemon/concourseSupervisor.ts')
const { workerTranscriptPath } = await import('../../src/services/concourse/workerTranscript.ts')
const { upsertObligation } = await import('../../src/services/crew/obligations.ts')
const { getTheme } = await import('../../src/utils/theme.ts')
const { GLYPH } = await import('../../src/components/mercury-ui/glyphs.ts')
const { STATE_GLYPH } = await import('../../src/components/concourse/ConcourseLayout.tsx')
const STATE_GLYPHS = new Set(Object.values(STATE_GLYPH).map(s => s.glyph))
const { keyHintLabel } = await import('../../src/components/mercury-ui/keyHintLabel.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const driver = resolveCaptureDriver()
if (driver.kind !== 'posix-pty') {
  console.error(`prove-finish-mark-drive: capture driver unavailable — ${driver.kind === 'unavailable' ? `${driver.reason}; ${driver.remedy}` : driver.kind}`)
  process.exit(1)
}

seedFirstRun(TEMPLATE, [CWD, OTHER])

{
  const sessionId = '00000000-dddd-4000-8000-000000000001'
  const file = workerTranscriptPath({ sessionId, workspaceId: OTHER })
  mkdirSync(dirname(file), { recursive: true })
  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    isSidechain: false,
    entrypoint: 'cli',
    cwd: OTHER,
    sessionId,
    version: '1.0.0-beta.1',
    gitBranch: 'main',
    parentUuid: null,
    uuid: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`,
    timestamp: new Date().toISOString(),
    ...extra,
  })
  writeFileSync(
    file,
    encodeSeedTranscript(
      [
        row({ type: 'user', message: { role: 'user', content: 'an old chat in q' } }),
        row({ type: 'assistant', message: { id: 'msg_q', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'a reply.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
      ] as never,
      sessionId,
    ),
  )
  const at = new Date(Date.now() - 60 * 60_000)
  utimesSync(file, at, at)
}

const RETIRED_REF = 'cross-project:finished:'
const STALE_SID = '00000000-eeee-4000-8000-000000000002'
const staleCrewDir = join(TEMPLATE, 'crew')
mkdirSync(staleCrewDir, { recursive: true })
const stale = await upsertObligation({
  ref: `${RETIRED_REF}${STALE_SID}:${Date.now() - 60_000}`,
  sessionId: STALE_SID,
  question: 'your agent in elsewhere finished · concourse-w9',
  owner: 'operator',
  scope: 'switchboard',
  dir: staleCrewDir,
})

const hexOf = (rgb: string): string => {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(rgb)
  if (!m) return rgb.replace(/^#/, '').toLowerCase()
  return [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, '0')).join('')
}
const theme = getTheme('dark')
const WARNING = hexOf(theme.warning)
const SUCCESS = hexOf(theme.success)

const READY_LINE = '↵ start  ·  ↑↓ choose'
const COMPOSER = 'Type a prompt'
const BOARD = 'SESSION CONCOURSE'
const TAG = keyHintLabel('⇧← back')
const SHIFT_LEFT = '\x1b[1;2D'
const DOWN = '\x1b[B'
const UP = '\x1b[A'
const CTRL_G = '\x07'
const ESC = String.fromCharCode(27)
const WARM_TICKS = 25

type Send = Record<string, unknown>
type Cell = { c: string; fg: string; bold?: boolean }
type Mark = { label: string; grid: Cell[][] }
type Capture = {
  home: string
  status: number
  tail: string
  payload: { grid?: Cell[][]; marks?: Mark[] }
}

function freshHome(id: string): string {
  const home = join(SCRATCH, `home-${id}`)
  cpSync(TEMPLATE, home, { recursive: true })
  return home
}

async function capture(opts: { id: string; home: string; sends: Send[]; resizes: Send[]; total: number }): Promise<Capture> {
  const api = await startFixtureApi([
    { kind: 'paced', deltas: ['Spare', '.'], gapMs: 300, startDelayMs: 6000 },
    { kind: 'text', text: 'Second reply.' },
    { kind: 'text', text: 'hello there' },
    ...Array.from({ length: 6 }, () => ({ kind: 'text' as const, text: 'Spare.' })),
  ])
  const cfgPath = join(SCRATCH, `cfg-${opts.id}.json`)
  const outPath = join(SCRATCH, `grid-${opts.id}.json`)
  writeFileSync(
    cfgPath,
    JSON.stringify({
      argv: ['node', BIN, '--model', 'claude-sonnet-5'],
      cwd: CWD,
      cols: 120,
      rows: 40,
      sends: opts.sends,
      resizes: opts.resizes,
      stableTicks: 4,
      total: opts.total,
      out: outPath,
    }),
  )
  const child = spawn(driver.python, [join(REPO, 'scripts', 'ui', 'vshot.py'), cfgPath], {
    env: {
      ...process.env,
      MERCURY_CONFIG_DIR: opts.home,
      MERCURY_LIVE_GLYPHS: '0',
      MERCURY_CACHE_CLOCK: '0',
      MERCURY_PARTY: '0',
      MERCURY_AWAY_SUMMARY: '0',
      ANTHROPIC_API_KEY: 'fixture-key-000',
      ANTHROPIC_BASE_URL: api.url,
      COLORTERM: 'truecolor',
      TERM: 'xterm-256color',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const result = await new Promise<Capture>(resolvePromise => {
    let tail = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(280_000))
    child.stdout.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.stderr.on('data', d => (tail = (tail + String(d)).slice(-800)))
    child.on('close', status => {
      clearTimeout(timer)
      let payload: Capture['payload'] = {}
      try {
        payload = JSON.parse(readFileSync(outPath, 'utf8')) as Capture['payload']
      } catch {
        payload = {}
      }
      resolvePromise({ home: opts.home, status: status ?? 1, tail, payload })
    })
  })
  try {
    await api.close()
  } catch {
    void 0
  }
  return result
}

const rowsOf = (grid: Cell[][]): string[] => grid.map(r => r.map(cell => cell.c || ' ').join('').replace(/\s+$/, ''))
function markGrid(c: Capture, label: string): Cell[][] {
  return (c.payload.marks ?? []).find(m => m.label === label)?.grid ?? []
}
const markText = (c: Capture, label: string): string => rowsOf(markGrid(c, label)).join('\n')

function inkNotes(grid: Cell[][]): string[] {
  const notes: string[] = []
  grid.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const fg = row[x]!.fg
      if (fg === WARNING || fg === SUCCESS) {
        let end = x
        while (end + 1 < row.length && row[end + 1]!.fg === fg) end += 1
        const text = row.slice(x, end + 1).map(cell => cell.c || ' ').join('').replace(/\s+$/, '')
        if (text.length > 0) notes.push(`row ${y + 1} cols ${x + 1}-${end + 1} ${fg === WARNING ? 'warning' : 'success'} (#${fg}): ${text}`)
        x = end + 1
      } else x += 1
    }
  })
  return notes
}

function writeFrame(c: Capture, label: string): void {
  if (FRAMES === null) return
  const grid = markGrid(c, label)
  writeFileSync(join(FRAMES, `${label}.txt`), `${rowsOf(grid).join('\n')}\n`)
  writeFileSync(join(FRAMES, `${label}.ink.txt`), `${inkNotes(grid).join('\n')}\n`)
}

function printFrame(id: string, text: string): void {
  console.log(`\n┌── ${id} ──`)
  for (const l of text.split('\n')) console.log(`│${l}`)
  console.log('└──')
}

type RowInk = { line: string; glyph: string | null; glyphFg: string | null; wordFg: string | null }
const TITLE_Z = 'hello there'
function rowInk(grid: Cell[][], title: string, needle: (line: string) => boolean): RowInk | undefined {
  const lines = rowsOf(grid)
  for (let y = 0; y < grid.length; y++) {
    const line = lines[y] ?? ''
    if (!line.includes(title) || !needle(line)) continue
    const row = grid[y]!
    const ti = line.indexOf(title)
    let gx = -1
    for (let x = ti - 1; x >= 0; x--) {
      const ch = row[x]!.c
      if (ch === '│') break
      if (STATE_GLYPHS.has(ch)) {
        gx = x
        break
      }
    }
    const wx = line.indexOf('ready')
    const word = wx !== -1 && gx !== -1 && wx > gx && wx < ti ? row[wx]!.fg : null
    return { line: line.trim().slice(0, 110), glyph: gx === -1 ? null : row[gx]!.c, glyphFg: gx === -1 ? null : row[gx]!.fg, wordFg: word }
  }
  return undefined
}
const listRow = (line: string): boolean => line.indexOf(TITLE_Z) <= 8 || (line.includes(basename(OTHER)) && line.indexOf(TITLE_Z) < line.indexOf(basename(OTHER)))
const starRow = (line: string): boolean => line.includes(GLYPH.sparkBright) && listRow(line)
const inkWord = (ink: RowInk | undefined): string => `${ink?.line ?? 'no row'} · glyph ${ink?.glyph ?? '?'} #${ink?.glyphFg ?? '?'}`
const isBoard = (t: string): boolean => t.includes(BOARD)
const isChat = (t: string): boolean => t.includes(COMPOSER) || t.includes(TAG)
const rowsWith = (t: string, needle: string): string => t.split('\n').filter(l => l.includes(needle)).map(l => l.trim().slice(0, 110)).join(' | ')
const firstRows = (t: string): string => t.split('\n').filter(l => l.trim()).slice(0, 3).map(l => l.trim().slice(0, 60)).join(' | ')

const g = (needle: string, data: string, extra: Send = {}): Send => ({ atTick: 999, requireAwait: true, awaitText: needle, minTick: 5, awaitSettleTicks: 2, data, ...extra })
const PICK_Q: Send[] = [
  { afterPrevTicks: 6, data: CTRL_G },
  { afterPrevTicks: 6, data: DOWN },
  { afterPrevTicks: 4, data: '\r' },
]
const PICK_P: Send[] = [
  { afterPrevTicks: 6, data: CTRL_G },
  { afterPrevTicks: 6, data: UP },
  { afterPrevTicks: 4, data: '\r' },
]

const recordsOf = (home: string): ReturnType<typeof readSessionWorkers> => readSessionWorkers(join(home, 'daemon'))
function reapHome(home: string): void {
  for (const rec of Object.values(recordsOf(home))) {
    if (rec.pid !== undefined) {
      try {
        process.kill(rec.pid, 'SIGTERM')
      } catch {
        void 0
      }
    }
  }
  try {
    const pidFile = join(home, 'daemon', 'daemon.pid')
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim())
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
    }
  } catch {
    void 0
  }
}

console.log(`prove-finish-mark-drive: bundle ${BIN}`)
console.log('a finish while the operator is elsewhere marks the row in amber until the session is opened; nothing is minted, nothing consumes the next words')
const home = freshHome('mark')
const MARK_SIZES = ['mark-120x40', 'mark-82x17', 'mark-80x21', 'mark-80x14'] as const
const AFTER_SIZES = ['after-120x40', 'after-82x17', 'after-80x21', 'after-80x14'] as const
const c = await capture({
  id: 'finish-mark',
  home,
  sends: [
    g(READY_LINE, '', { mark: 'face' }),
    { afterPrevTicks: WARM_TICKS, data: '\r' },
    g(COMPOSER, SHIFT_LEFT, { awaitSettleTicks: 4 }),
    ...PICK_Q,
    { afterPrevTicks: 12, data: '\t' },
    { afterPrevTicks: 2, data: 'n' },
    { afterPrevTicks: 6, data: ESC },
    g(COMPOSER, 'hello there\r', { awaitSettleTicks: 2 }),
    { afterPrevTicks: 2, data: SHIFT_LEFT },
    ...PICK_P,
    { afterPrevTicks: 60, data: '', mark: 'p-board-finished' },
    ...PICK_Q,
    { afterPrevTicks: 20, data: '', mark: 'mark-120x40' },
    { afterPrevTicks: 12, data: '', mark: 'mark-82x17' },
    { afterPrevTicks: 12, data: '', mark: 'mark-80x21' },
    { afterPrevTicks: 12, data: '', mark: 'mark-80x14' },
    { afterPrevTicks: 12, data: '', mark: 'mark-restored' },
    { afterPrevTicks: 4, data: UP },
    { afterPrevTicks: 3, data: UP },
    { afterPrevTicks: 3, data: '\r' },
    { afterPrevTicks: 6, data: '\r' },
    g(TAG, '', { awaitSettleTicks: 6, mark: 'chat-opened' }),
    { afterPrevTicks: 3, data: 'second words\r' },
    { afterPrevTicks: 45, awaitText: 'Second reply.', awaitSettleTicks: 4, data: '', mark: 'chat-replied' },
    { afterPrevTicks: 4, data: SHIFT_LEFT },
    { afterPrevTicks: 14, data: '', mark: 'after-120x40' },
    { afterPrevTicks: 12, data: '', mark: 'after-82x17' },
    { afterPrevTicks: 12, data: '', mark: 'after-80x21' },
    { afterPrevTicks: 12, data: '', mark: 'after-80x14' },
    { afterPrevTicks: 12, data: '', mark: 'after-restored' },
  ],
  resizes: [
    { afterMark: 'mark-120x40', afterMs: 400, cols: 82, rows: 17 },
    { afterMark: 'mark-82x17', afterMs: 400, cols: 80, rows: 21 },
    { afterMark: 'mark-80x21', afterMs: 400, cols: 80, rows: 14 },
    { afterMark: 'mark-80x14', afterMs: 400, cols: 120, rows: 40 },
    { afterMark: 'after-120x40', afterMs: 400, cols: 82, rows: 17 },
    { afterMark: 'after-82x17', afterMs: 400, cols: 80, rows: 21 },
    { afterMark: 'after-80x21', afterMs: 400, cols: 80, rows: 14 },
    { afterMark: 'after-80x14', afterMs: 400, cols: 120, rows: 40 },
  ],
  total: 700,
})
for (const label of ['face', 'p-board-finished', ...MARK_SIZES, 'mark-restored', 'chat-opened', 'chat-replied', ...AFTER_SIZES, 'after-restored']) writeFrame(c, label)
check('the capture ran whole', c.status === 0 && (c.payload.marks ?? []).length > 0, `vshot exit ${c.status}: ${c.tail.slice(-400)}`)

const pBoard = markText(c, 'p-board-finished')
printFrame("P's board once Z settled in Q (the view elsewhere)", pBoard)
check('P\'s board is on screen once Z\'s turn settled elsewhere', isBoard(pBoard), firstRows(pBoard))
check('Z rides P\'s board as the ✦ carry-over from Q, settled (● ready), not working', pBoard.split('\n').some(l => starRow(l) && l.includes(TITLE_Z) && l.includes(GLYPH.ok)), rowsWith(pBoard, GLYPH.sparkBright))
check('nothing was minted for the finish: no "needs you" count, no "switch to · finished" row on P\'s board', !/[1-9]\d* needs? you/.test(pBoard) && !pBoard.includes('· finished') && !pBoard.includes('NEEDS YOU'), rowsWith(pBoard, 'need') || rowsWith(pBoard, 'finished'))
const starInk = rowInk(markGrid(c, 'p-board-finished'), TITLE_Z, starRow)
check(`the carried row is ready (${GLYPH.ok}) and its state glyph wears the board's amber (#${WARNING}) while the finish stands unseen`, starInk?.glyph === GLYPH.ok && starInk.glyphFg === WARNING, inkWord(starInk))
const xInk = rowInk(markGrid(c, 'p-board-finished'), 'new session', line => line.includes(basename(CWD)) && !line.includes('running in'))
check(`X, the wordless newborn of P, stays ready in the green (#${SUCCESS}) — no finish, no mark`, xInk?.glyph === GLYPH.ok && xInk.glyphFg === SUCCESS, inkWord(xInk))

for (const label of MARK_SIZES) {
  const text = markText(c, label)
  const ink = rowInk(markGrid(c, label), TITLE_Z, listRow)
  if (label === 'mark-120x40') printFrame("Q's board with the unseen finish", text)
  check(`${label}: Q's board shows Z ready (${GLYPH.ok}) with the state glyph in amber (#${WARNING})`, ink?.glyph === GLYPH.ok && ink.glyphFg === WARNING, inkWord(ink))
  if (label === 'mark-120x40') check(`${label}: the selected row's state word 'ready' wears the same amber`, ink?.wordFg === WARNING, `word #${ink?.wordFg ?? 'absent'}`)
  check(`${label}: no ⚑ count and no finished note anywhere on the frame`, !/[1-9]\d* needs? you/.test(text) && !text.includes('· finished'), rowsWith(text, 'need'))
}

const replied = markText(c, 'chat-replied')
check('↵ ↵ on Z\'s row opened its chat (the hop): its first words stand in the transcript once the second turn has painted', isChat(replied) && replied.includes(TITLE_Z), firstRows(replied))
check('the chat\'s strip carries no ⚑ count — nothing stood as a need', !/⚑ [1-9]\d* needs? you/.test(replied), rowsWith(replied, '⚑'))
console.log(`  the second turn's reply ${replied.includes('Second reply.') ? 'painted' : 'had not painted'} in the chat window`)

for (const label of AFTER_SIZES) {
  const text = markText(c, label)
  const ink = rowInk(markGrid(c, label), TITLE_Z, listRow)
  if (label === 'after-120x40') printFrame("Q's board after the open and a settle watched in the chat", text)
  check(`${label}: after the open, and a turn watched to its settle then ⇧←, Z is ready (${GLYPH.ok}) in the green again (#${SUCCESS})`, ink?.glyph === GLYPH.ok && ink.glyphFg === SUCCESS, inkWord(ink))
  if (label === 'after-120x40') check(`${label}: the selected row's state word is green too`, ink?.wordFg === SUCCESS, `word #${ink?.wordFg ?? 'absent'}`)
}

const ledgerPath = join(home, 'daemon', 'concourse-dispatches.json')
let ledgerRows: Array<{ clientMessageId: string; state?: string; sessionId?: string; by?: string }> = []
try {
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { dispatches?: Record<string, { clientMessageId: string; state?: string; sessionId?: string; by?: string }> }
  ledgerRows = Object.values(ledger.dispatches ?? {})
} catch {
  ledgerRows = []
}
const answers = ledgerRows.filter(r => String(r.clientMessageId).startsWith('obl-answer:'))
const plain = ledgerRows.filter(r => /^[0-9a-f-]{36}$/.test(String(r.clientMessageId)) && (r.state === 'delivered' || r.state === 'working' || r.state === 'settled' || r.state === 'done'))
console.log(`  dispatch ledger: ${ledgerRows.length} rows, ${plain.length} plain-id deliveries, ${answers.length} obligation answers`)
check('the words typed after the finish rode the ledger as plain prompts — no obligation answer anywhere', answers.length === 0 && ledgerRows.length >= 2, ledgerRows.map(r => `${String(r.clientMessageId).slice(0, 18)}:${r.state}`).join(', '))

const oblPath = join(home, 'crew', 'obligations-switchboard.json')
let oblRows: Array<{ obligationId: string; ref?: string; status?: string; settlement?: { by?: string; kind?: string } }> = []
try {
  const file = JSON.parse(readFileSync(oblPath, 'utf8')) as { obligations?: Record<string, { obligationId: string; ref?: string; status?: string; settlement?: { by?: string; kind?: string } }> }
  oblRows = Object.values(file.obligations ?? {})
} catch {
  oblRows = []
}
const retired = oblRows.filter(r => String(r.ref ?? '').startsWith(RETIRED_REF))
const planted = oblRows.find(r => r.obligationId === stale.obligationId)
console.log(`  obligations: ${oblRows.length} rows, ${retired.length} of the retired kind (${retired.map(r => r.status).join(', ') || 'none'})`)
check('no finish was minted as an obligation during the run (the planted row is the only one of the retired kind)', retired.length === 1 && retired[0]?.obligationId === stale.obligationId, retired.map(r => `${r.status}:${String(r.ref).slice(0, 40)}`).join(', '))
check('the retired row that stood in the store before the boot is withdrawn at the first sweep, never counted, never answered', planted?.status === 'withdrawn' && planted.settlement?.by === 'retired-kind', `${planted?.status ?? 'absent'} by ${planted?.settlement?.by ?? '—'}`)
const face = markText(c, 'face')
check('the boot face never showed the standing retired row as a need', !/[1-9]\d* needs? you/.test(face), rowsWith(face, 'need'))

const live = Object.values(recordsOf(home)).filter(r => r.endedAt === undefined)
check('both sessions are live at the end — one in P, one in Q — none paused, parked, stopped or released by the mark', live.length === 2 && live.some(r => r.workspaceId === CWD) && live.some(r => r.workspaceId === OTHER) && live.every(r => r.pausedAt === undefined && r.stoppedAt === undefined && r.parkedAt === undefined), JSON.stringify(live.map(r => basename(r.workspaceId))))

if (failures > 0) {
  for (const label of ['face', 'mark-82x17', 'mark-80x21', 'mark-80x14', 'chat-opened', 'chat-replied', 'after-82x17']) printFrame(label, markText(c, label))
  const daemonLog = join(home, 'daemon', 'daemon.log')
  if (existsSync(daemonLog)) console.log(`\n── daemon log tail ──\n${readFileSync(daemonLog, 'utf8').slice(-1500)}`)
}
reapHome(home)
if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
else console.log(`scratch kept at ${SCRATCH}`)
console.log(failures === 0 ? '\nprove-finish-mark-drive: ALL LAWS HOLD' : `\nprove-finish-mark-drive: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
