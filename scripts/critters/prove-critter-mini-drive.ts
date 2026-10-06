#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { compactGrid, DEFAULT_MASKS, firstDivergence, type StoredGrid } from '../ui/visualBaseline.ts'

const ROOT = resolve(import.meta.dir, '../..')
const argAfter = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}
const DIST = argAfter('--dist') ?? join(ROOT, 'dist/mercury.mjs')
const FRAMES = argAfter('--frames')
const mountsOnly = process.argv.includes('--mounts-only')
const VSHOT = join(ROOT, 'scripts/ui/vshot.py')
const VENDORED_NODE = join(DIST, '../vendor/node/bin/node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const DEAD = 'http://127.0.0.1:9'
let requests = 0
const pending = createServer((req, res) => {
  if (req.method === 'POST') { requests++; return }
  res.writeHead(404).end()
})
await new Promise<void>(resolve => pending.listen(0, '127.0.0.1', resolve))
const fixtureBase = `http://127.0.0.1:${(pending.address() as { port: number }).port}`
const KEY = 'proof-key-ci-gate-not-a-real-key'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

if (!existsSync(DIST)) {
  console.error('prove-critter-mini-drive: dist/mercury.mjs missing — run the build first (the gate prebuilds it)')
  process.exit(1)
}

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Send = { data: string; targetText?: string; awaitText?: string; awaitPattern?: string; awaitSettleTicks?: number; afterPrevTicks?: number; minTick?: number; requireAwait?: boolean; mark?: string }
type Capture = { grid: Grid; marks: Record<string, Grid>; endReason: string }

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'critter-mini-'))
process.env.ANTHROPIC_API_KEY = KEY

const WRAP_VERB = 'Reading the complete fixture response and checking every part of it'
const STACK_VERB = 'Reading the whole fixture answer before replying'
const TALL_VERB = `${WRAP_VERB} against the recorded expectations before answering`
const GROW_VERB = 'Basking'
const ONE_LINE_COLS = 130

function homeFor(name: string, verb = name.startsWith('busy-') ? WRAP_VERB : undefined): { configHome: string; cwd: string } {
  const world = join(scratch, name)
  const cwd = join(world, 'fixture-cwd')
  const configHome = join(world, 'confighome')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configHome, { recursive: true })
  seedFirstRun(configHome, [cwd])
  if (verb !== undefined) writeFileSync(join(configHome, 'settings.json'), JSON.stringify({ activity: { verbs: { mode: 'replace', verbs: [verb] } } }))
  return { configHome, cwd }
}

const faceEnter: Send = { requireAwait: true, awaitText: '↑↓ choose', minTick: 35, awaitSettleTicks: 4, data: '\r' }
const onReady = (data: string, mark: string): Send => ({ requireAwait: true, awaitText: 'ready ·', targetText: '⇧← back', awaitSettleTicks: 6, data, mark })
const WORK_REPORTED = '⤳ WORKFLOW[^\\n]*\\n[^\\n]*\\bidle\\b'
const onReported = (data: string, mark: string): Send => ({ ...onReady(data, mark), awaitPattern: WORK_REPORTED })

type Resize = { atTick?: number; afterMark?: string; afterMs?: number; cols: number; rows: number }
async function capture(tag: string, world: { configHome: string; cwd: string }, cols: number, rows: number, sends: Send[], readyText: string, resizes: Resize[] = [], live = false, envPatch: Record<string, string> = {}): Promise<Capture> {
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, DIST], cwd: world.cwd, sends: [faceEnter, ...sends], readyText: readyText === 'ready ·' ? [readyText, '⇧← back'] : [readyText], readySettleTicks: 8, stableTicks: live ? 0 : 4, total: 400, cols, rows, out, resizes }))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    USER: 'sam',
    TERM: 'xterm-256color',
    TERM_PROGRAM: 'vscode',
    BROWSER: '/usr/bin/true',
    MERCURY_CONFIG_DIR: world.configHome,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_LIVE_GLYPHS: live ? '1' : '0',
    MERCURY_OPERATOR: 'sam',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_AWAY_SUMMARY: '0',
    MERCURY_TURN_RECEIPT: '0',
    MERCURY_CRITTER: 'clam',
    MERCURY_HEALTH_STATE_DIR: join(scratch, 'health-state'),
    MERCURY_DAEMON_DIR: join(scratch, `${tag}-daemon`),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_HOME: join(scratch, 'proof-home'),
    ANTHROPIC_API_KEY: KEY,
    MERCURY_ANTHROPIC_OAUTH_BASE: 'http://127.0.0.1:1',
    ANTHROPIC_BASE_URL: fixtureBase,
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
    ...envPatch,
  }
  for (const key of ['NODE_ENV', 'MERCURY_DEMO', 'CI', 'ANTHROPIC_AUTH_TOKEN', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN']) delete env[key]
  const child = spawn('/usr/bin/python3', [VSHOT, cfgPath], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const timer = setTimeout(() => child.kill('SIGKILL'), vshotBudgetMs(150_000))
  const code: number = await new Promise(done => child.on('close', c => done(c ?? 1)))
  clearTimeout(timer)
  if (code !== 0 || !existsSync(out)) throw new Error(`${tag}: vshot exit ${code} — ${stderr.slice(-400)}`)
  const payload = JSON.parse(readFileSync(out, 'utf8')) as { grid: Grid; endReason: string; marks?: Array<{ label: string; grid: Grid }>; stages?: Array<{ cols: number; rows: number; grid: Grid }> }
  const marks: Record<string, Grid> = {}
  for (const m of payload.marks ?? []) marks[m.label] = m.grid
  for (const [i, stage] of (payload.stages ?? []).entries()) marks[`stage${i}:${stage.cols}x${stage.rows}`] = stage.grid
  if (FRAMES !== undefined) {
    mkdirSync(FRAMES, { recursive: true })
    for (const [name, grid] of Object.entries({ final: payload.grid, ...marks })) {
      const base = join(FRAMES, `${tag}-${name.replaceAll(':', '-')}`)
      writeFileSync(`${base}.json`, JSON.stringify({ cols: grid[0]?.length, rows: grid.length, grid }))
      writeFileSync(`${base}.txt`, grid.map(row => row.map(cell => cell.c).join('')).join('\n') + '\n')
    }
  }
  return { grid: payload.grid, marks, endReason: payload.endReason }
}

const text = (g: Grid): string[] => g.map(row => row.map(c => c.c).join(''))
const rowWith = (g: Grid, needle: string): number => text(g).findIndex(line => line.includes(needle))
const sameCell = (a: Cell, b: Cell): boolean => a.c === b.c && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.rev === b.rev
const compact = (grid: Grid): StoredGrid => compactGrid({ cols: grid[0]?.length ?? 0, rows: grid.length, grid })
function sameFrame(label: string, a: Grid, b: Grid): void {
  const divergence = firstDivergence(compact(a), compact(b), DEFAULT_MASKS)
  check(label, divergence === null, JSON.stringify(divergence))
}
function sameLook(label: string, a: Grid, b: Grid): void {
  const bottom = paneBottom(b, 30, 147)
  const regions: Array<[number, number, number, number]> = [[0, 6, 30, 178], [6, bottom, 148, 178], [bottom, 51, 0, 178], [8, 18, 30, 148]]
  let off = 0
  let first = ''
  for (const [r0, r1, c0, c1] of regions) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
    if (sameCell(a[r]![c]!, b[r]![c]!)) continue
    off++
    if (!first) first = `row ${r} col ${c}: ${JSON.stringify(a[r]![c]!.c)} vs ${JSON.stringify(b[r]![c]!.c)}`
  }
  check(label, off === 0 && paneBottom(a, 30, 147) === bottom, `${off} cells differ (${first}); pane bottom ${paneBottom(a, 30, 147)} vs ${bottom}`)
}
function boxRows(g: Grid, left: number): { top: number; bottom: number } {
  const t = text(g)
  let top = -1
  let bottom = -1
  for (let r = 1; r < t.length && r < 4; r++) if (t[r]![left] === '╭') { top = r; break }
  for (let r = top + 1; r < t.length && top >= 0; r++) if (t[r]![left] === '╰') { bottom = r; break }
  return { top, bottom }
}
function slotLeft(g: Grid): number {
  const border = text(g)[1] ?? ''
  return border.indexOf('╭') + 3
}

type Berth = { left: number; right: number; top: number; bottom: number; cardTop: number; cardBottom: number; cardLeft: number; x: number; y: number; cells: number }
function berthOf(g: Grid): Berth {
  const t = text(g)
  const border = t[1] ?? ''
  const left = border.indexOf('╭')
  const right = border.lastIndexOf('╮')
  const { top, bottom } = boxRows(g, left)
  const inner = t.slice(top + 1, bottom)
  const cardTop = inner.findIndex(row => row.indexOf('╭', left + 1) >= 0)
  const cardBottom = inner.findIndex(row => row.indexOf('╰', left + 1) >= 0)
  const cardLeft = inner.map(row => row.indexOf('╭', left + 1)).find(c => c >= 0) ?? -1
  const art: Array<[number, number]> = []
  for (let r = top + 1; r < bottom; r++) for (let c = left + 1; c < right; c++) if (g[r]![c]!.c === '▀' || g[r]![c]!.c === '▄') art.push([c, r])
  return {
    left, right, top, bottom,
    cardTop: cardTop < 0 ? -1 : top + 1 + cardTop,
    cardBottom: cardBottom < 0 ? -1 : top + 1 + cardBottom,
    cardLeft,
    x: art.length ? Math.min(...art.map(cell => cell[0])) : -1,
    y: art.length ? Math.min(...art.map(cell => cell[1])) : -1,
    cells: art.length,
  }
}
const cardRows = (b: Berth): number => b.cardTop < 0 ? 0 : b.cardBottom - b.cardTop + 1
const spriteTop = (b: Berth): number => b.cardTop + Math.ceil((cardRows(b) - 3) / 2)

type Card = { left: number; right: number; top: number; bottom: number; artRows: number; artWidth: number }
function cardOf(g: Grid, name: string): Card {
  const t = text(g)
  const nameRow = rowWith(g, name)
  const none: Card = { left: -1, right: -1, top: -1, bottom: -1, artRows: 0, artWidth: 0 }
  if (nameRow < 0) return none
  const line = t[nameRow]!
  const at = line.indexOf(name)
  const left = line.lastIndexOf('│', at)
  const right = line.indexOf('│', at)
  let top = -1
  let bottom = -1
  for (let r = nameRow - 1; r >= 0; r--) if (t[r]![left] === '╭') { top = r; break }
  for (let r = nameRow + 1; r < t.length; r++) if (t[r]![left] === '╰') { bottom = r; break }
  if (left < 0 || right < 0 || top < 0 || bottom < 0) return none
  let artRows = 0
  let artWidth = 0
  for (let r = top + 1; r < bottom; r++) {
    const run = t[r]!.slice(left + 1, right).match(/[▀▄█]+/g)
    if (!run) continue
    artRows++
    artWidth = Math.max(artWidth, ...run.map(m => m.length))
  }
  return { left, right, top, bottom, artRows, artWidth }
}

function paneBottom(g: Grid, left: number, right: number): number {
  const t = text(g)
  for (let r = t.length - 1; r > 0; r--) if (t[r]![left] === '╰' && t[r]![right] === '╯') return r
  return -1
}

console.log('============================================================')
console.log(' the small critter in the slim session box, the view reaching the status row — driven')
console.log('============================================================')

try {
  if (!mountsOnly) {
  const wide = homeFor('wide')
  const a = await capture('wide-a', wide, 178, 51, [onReported('/view on\r', 'boot')], 'Unknown command')
  const boot = a.marks['boot']!
  const typed = a.grid
  const band = await capture('band', homeFor('band'), 80, 21, [], '1 session on')
  const mid = homeFor('mid')
  const c = await capture('mid', mid, 120, 40, [onReady('', 'boot')], '← back')
  const midBoot = c.marks['boot']!
  const trip = await capture('trip', homeFor('trip'), 178, 51, [onReady('', 'wide')], '← back', [{ atTick: 70, cols: 80, rows: 21 }, { atTick: 85, cols: 178, rows: 51 }])
  const tripWide = trip.marks['wide']!
  const tripNarrow = trip.marks['stage1:80x21']!
  const tripBack = trip.grid
  const tall = await capture('tall', homeFor('tall'), 80, 30, [{ requireAwait: true, awaitText: '1 session on', awaitSettleTicks: 6, data: '', mark: 'boot' }], '1 session on')
  const tallBoot = tall.marks['boot']!

  console.log('§1 the slim box at 178×51 (the one look; no setting), the pane\'s first interior row')
  const bx = boxRows(boot, 31)
  check('no title row paints above the box: the pane\'s top border is row 0 and nothing reads ✶ VIEW', rowWith(boot, '✶ VIEW') === -1 && text(boot)[0]!.includes('╭') , `row ${rowWith(boot, '✶ VIEW')}`)
  check('the session box is five rows under the pane\'s top border: border at row 1, border at row 5', bx.top === 1 && bx.bottom === 5, `top ${bx.top} bottom ${bx.bottom}`)
  let spriteDiff = 0
  const bootLeft = slotLeft(boot)
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(boot[2 + r]![bootLeft + col]!, band.grid[r]![2 + col]!)) spriteDiff++
  check('the three inner rows carry the band sprite at the slot\'s left (27 cells)', spriteDiff === 0, `${spriteDiff} cells differ, expected column ${bootLeft}`)
  check('the sprite cells at the slot\'s left are half-block glyphs', boot.slice(2, 5).every(row => row.slice(bootLeft, bootLeft + 9).every(cell => cell.c === '▀' || cell.c === '▄')))
  const ground = boot[6]![33]!.bg
  let tintOff = 0
  for (let r = 2; r <= 4; r++) for (let col = 32; col <= 145; col++) { if (col >= bootLeft && col < bootLeft + 9) continue; const cell = boot[r]![col]!; if (cell.c !== ' ' || cell.bg !== ground) tintOff++ }
  check('the rest of the three rows is the box’s own tint (blank cells on the pane ground)', tintOff === 0, `${tintOff} cells off`)
  check('nothing paints beside the idle sprite (no border glyph on its rows)', boot.slice(2, 5).every(row => !row.slice(43, 146).some(cell => cell.c === '╭' || cell.c === '│')))

  console.log('§2 no SESSIONS bar paints under the view; the view reaches the status row')
  check('no row of the frame reads ⊞ SESSIONS', rowWith(boot, '⊞ SESSIONS') === -1, `row ${rowWith(boot, '⊞ SESSIONS')}`)
  check('no row of the frame reads ▣ this session', rowWith(boot, '▣ this session') === -1)
  const paneOff = paneBottom(boot, 30, 147)
  check('the pane’s bottom border sits on row 44, directly above the status row', paneOff === 44 && text(boot)[45]!.includes('ready ·'), `pane ${paneOff}`)
  check('the chat has thirty-eight inner rows under the box', paneOff - bx.bottom - 1 === 38, `${paneOff} vs ${bx.bottom}`)

  console.log('§3 the landing form sits under the box')
  check('the wordmark starts three rows under the box', text(boot)[bx.bottom + 3]!.includes('█▄▄▄█'))
  check('● ready six rows under the box', text(boot)[bx.bottom + 6]!.includes('● ready · type a prompt, or / for commands'))
  check('model · theme · dir eight, nine and ten rows under the box', text(boot)[bx.bottom + 8]!.includes('model') && text(boot)[bx.bottom + 9]!.includes('theme') && text(boot)[bx.bottom + 10]!.includes('dir'))
  check('the ↵ sends row twelve rows under the box', text(boot)[bx.bottom + 12]!.includes('❯ ↵ sends'))

  console.log('§4 /view is an unknown command like any other')
  check('typed, /view on answers the ordinary unknown-command line', rowWith(typed, 'Unknown command: /view') >= 0)
  check('…and paints no bar, the box stays five rows and the pane keeps its bottom border', rowWith(typed, '⊞ SESSIONS') === -1 && boxRows(typed, 31).top === 1 && boxRows(typed, 31).bottom === 5 && paneBottom(typed, 30, 147) === 44)
  sameLook('the answer repaints nothing outside the chat’s own rows', typed, boot)

  console.log('§6 the same slim box at 120×40')
  const midLeft = text(midBoot)[1]!.indexOf('╭')
  const mx = boxRows(midBoot, midLeft)
  check('the box is five rows under the pane’s top border', mx.top === 1 && mx.bottom === 5, `top ${mx.top} bottom ${mx.bottom}`)
  check('no row reads ⊞ SESSIONS or ✶ VIEW', rowWith(midBoot, '⊞ SESSIONS') === -1 && rowWith(midBoot, '✶ VIEW') === -1)
  let midSprite = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(midBoot[mx.top + 1 + r]![slotLeft(midBoot) + col]!, band.grid[r]![2 + col]!)) midSprite++
  check('the sprite cells equal the band’s (27 cells)', midSprite === 0, `${midSprite} cells differ`)
  const midBottom = paneBottom(midBoot, midLeft - 1, text(midBoot)[mx.top]!.lastIndexOf('╮') + 1)
  check('the pane’s bottom border sits directly above the status row', midBottom >= 0 && text(midBoot)[midBottom + 1]!.includes('ready ·'), `pane ${midBottom}`)

  console.log('§7 a resize from wide to narrow and back keeps the one sprite')
  let tripDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripWide[2 + r]![slotLeft(tripWide) + col]!, band.grid[r]![2 + col]!)) tripDiff++
  check('wide before the resize: the box carries the band’s sprite cells', tripDiff === 0, `${tripDiff} cells differ`)
  check('wide before the resize: no bar', rowWith(tripWide, '⊞ SESSIONS') === -1)
  let narrowDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripNarrow[r]![2 + col]!, band.grid[r]![2 + col]!)) narrowDiff++
  check('narrow: the 80×21 band paints the same sprite cells', narrowDiff === 0, `${narrowDiff} cells differ`)
  check('narrow: the compact layout paints no bar', rowWith(tripNarrow, '⊞ SESSIONS') === -1)
  sameFrame('wide again: the frame is the wide frame cell for cell', tripBack, tripWide)

  console.log('§8 a compact window paints the one sprite')
  let tallDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tallBoot[r]![2 + col]!, band.grid[r]![2 + col]!)) tallDiff++
  check('80×30: the band’s rows 0–2 carry the 80×21 sprite cells (27 cells)', tallDiff === 0, `${tallDiff} cells differ`)
  check('80×30: no half-block art below the three sprite rows', !tallBoot.slice(3, 7).some(row => row.slice(0, 16).some(cell => cell.c === '▀' || cell.c === '▄')))

  console.log('§9 the 80×21 band is untouched')
  check('the 80×21 band paints the dock sprite at rows 0–2, columns 2–10', band.grid.slice(0, 3).every(row => row.slice(2, 11).every(cell => cell.c === '▀' || cell.c === '▄')))
  check('the band’s status row reads 1 session on', rowWith(band.grid, '1 session on') === 20, `row ${rowWith(band.grid, '1 session on')}`)

  console.log('§11 the small critter keeps the slot\'s left and the working card keeps its column')
  for (const [cols, rows] of [[178, 51], [120, 40], [100, 30]] as const) {
    const idle = cols === 178 ? boot : cols === 120 ? midBoot : (await capture('floor', homeFor('floor'), cols, rows, [], 'ready ·')).grid
    const border = text(idle)[1]!
    const left = border.indexOf('╭')
    const bounds = boxRows(idle, left)
    const at = slotLeft(idle)
    check(`${cols}×${rows}: the idle sprite sits at the slot's left and fills the three inner rows`, bounds.bottom - bounds.top === 4 && idle.slice(bounds.top + 1, bounds.bottom).every(row => row.slice(at, at + 9).every(cell => cell.c === '▀' || cell.c === '▄')), `expected ${at},${bounds.top + 1}`)
    const busy = await capture(`busy-${cols}x${rows}`, homeFor(`busy-${cols}`), cols, rows, [onReady('hello fixture\r', 'idle')], 'first byte', [], true)
    const b = berthOf(busy.grid)
    check(`${cols}×${rows}: work paints beside the sprite`, b.cardLeft > left && b.cells === 27, `card ${b.cardLeft}, art cells ${b.cells}`)
    check(`${cols}×${rows}: the card keeps its column`, b.cardLeft === left + 16, `card ${b.cardLeft}, expected ${left + 16}`)
    check(`${cols}×${rows}: the busy sprite keeps the slot's left, its middle on the card's middle`, b.x === left + 3 && b.y === spriteTop(b), `sprite ${b.x},${b.y}; card ${b.cardTop}..${b.cardBottom} (${cardRows(b)} rows), expected ${left + 3},${spriteTop(b)}`)
  }
  console.log('§14 the sprite’s middle tracks the thinking box’s middle however tall the box grows')
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    const legs: Array<[string, string, number, number]> = [['one', GROW_VERB, 3, ONE_LINE_COLS], ['stack', STACK_VERB, 4, cols], ['tall', TALL_VERB, cols === 120 ? 5 : 6, cols]]
    for (const [leg, verb, expectedRows, legCols] of legs) {
      const shot = await capture(`level-${leg}-${cols}x${rows}`, homeFor(`level-${leg}-${cols}`, verb), legCols, rows, [onReady('hello fixture\r', 'idle')], 'first byte', [], true)
      const b = berthOf(shot.grid)
      check(`${legCols}×${rows} ${leg}: the thinking box is ${expectedRows} rows tall with the complete sprite beside it${leg === 'one' ? ' (the reading-phase meta shares the verb’s line only from 130 columns: at 120 and 100 it stacks under even the shortest verb)' : ''}`, cardRows(b) === expectedRows && b.cells === 27 && b.bottom - b.top - 1 === expectedRows, `card ${b.cardTop}..${b.cardBottom} (${cardRows(b)} rows), box ${b.top}..${b.bottom}, art cells ${b.cells}`)
      check(`${legCols}×${rows} ${leg}: the sprite’s middle is the box’s middle, the lower middle row for an even box (sprite rows ${spriteTop(b)}–${spriteTop(b) + 2})`, b.y === spriteTop(b), `sprite top ${b.y}, expected ${spriteTop(b)}`)
      check(`${legCols}×${rows} ${leg}: no sprite row lies beside the box’s top border unless the box is three rows`, expectedRows === 3 || b.y > b.cardTop, `sprite rows ${b.y}–${b.y + 2}, top border ${b.cardTop}`)
    }
    const wide = ONE_LINE_COLS
    const grow = await capture(`grow-${cols}x${rows}`, homeFor(`grow-${cols}`, GROW_VERB), wide, rows, [
      onReady('hello fixture\r', 'idle'),
      { requireAwait: true, awaitText: GROW_VERB, awaitSettleTicks: 5, data: '', mark: 'one-line' },
    ], '│ (', [{ afterMark: 'one-line', afterMs: 400, cols, rows }], true)
    const before = berthOf(grow.marks[`stage0:${wide}x${rows}`]!)
    const after = berthOf(grow.grid)
    console.log(`  ${cols}×${rows} grow: the box is ${cardRows(before)} rows at ${wide} columns and ${cardRows(after)} rows at ${cols} (sprite top ${before.y} → ${after.y})`)
    check(`${cols}×${rows} grow: at ${wide} columns the status (reading the prompt · the clock · the first-byte promise) fits one line beside the verb and the box is three rows`, cardRows(before) === 3 && before.cells === 27 && before.y === before.cardTop, `card ${before.cardTop}..${before.cardBottom} (${cardRows(before)} rows), sprite top ${before.y}, art cells ${before.cells}`)
    check(`${cols}×${rows} grow: at ${cols} columns the meta stacks and the box is four rows`, cardRows(after) === 4 && after.cells === 27, `card ${after.cardTop}..${after.cardBottom} (${cardRows(after)} rows), art cells ${after.cells}`)
    check(`${cols}×${rows} grow: once the stats stack the sprite sits on the box’s lower three rows (the verb line, the stats, the bottom border)`, after.y === after.cardTop + 1, `sprite top ${after.y}, card top ${after.cardTop}`)
    check(`${cols}×${rows} grow: the sprite moves down one row as the box grows from three rows to four, its middle following the box’s middle`, after.y === before.y + 1 && before.cardTop === after.cardTop, `sprite top ${before.y} → ${after.y}, card top ${before.cardTop} → ${after.cardTop}`)
  }
  console.log('§12 /critter opens the picker with the small sprite on every card, at 178 and at 60 columns')
  const pickerWide = await capture('picker-178x51', homeFor('picker-178'), 178, 51, [onReady('/critter\r', 'landing')], 'Session theme')
  const pickerNarrow = await capture('picker-60x40', homeFor('picker-60'), 60, 40, [{ requireAwait: true, awaitText: '1 session on', awaitSettleTicks: 6, data: '/critter\r', mark: 'landing' }], 'Session theme')
  for (const [cols, shot, rowsExpected] of [[178, pickerWide, 1], [60, pickerNarrow, 2]] as const) {
    const cards = ['[1] crab', '[2] octopus', '[3] jellyfish', '[4] clam'].map(name => cardOf(shot.grid, name))
    check(`${cols} columns: the four cards paint with their names`, cards.every(c => c.top >= 0 && c.bottom > c.top), cards.map(c => `${c.top}..${c.bottom}`).join(' '))
    check(`${cols} columns: every card is eight rows with three sprite rows and the sprite nine cells wide`, cards.every(c => c.bottom - c.top === 7 && c.artRows === 3 && c.artWidth === 9), cards.map(c => `${c.bottom - c.top + 1} rows, art ${c.artRows}×${c.artWidth}`).join(' · '))
    check(`${cols} columns: every card is eighteen columns wide`, cards.every(c => c.right - c.left === 17), cards.map(c => `${c.right - c.left + 1}`).join(' '))
    check(`${cols} columns: the cards sit on ${rowsExpected} row${rowsExpected > 1 ? 's' : ''}`, new Set(cards.map(c => c.top)).size === rowsExpected, [...new Set(cards.map(c => c.top))].join(','))
    check(`${cols} columns: the landing before /critter carries the box sprite alone`, !text(shot.marks['landing']!).some(line => line.includes('[1] crab')))
  }
  const companion = await capture('companion-178x51', homeFor('companion-178'), 178, 51, [onReady('/companion tip\r', 'landing'), { requireAwait: true, awaitText: 'Unknown command', awaitSettleTicks: 6, data: '', mark: 'answer' }], 'Unknown command')
  check('/companion is no command: the chat answers Unknown command and no tip line paints', rowWith(companion.grid, 'Unknown command: /companion') >= 0 && rowWith(companion.grid, 'tip —') === -1, `row ${rowWith(companion.grid, 'Unknown command: /companion')}`)
  check('/companion leaves the box five rows with the sprite alone', boxRows(companion.grid, 31).top === 1 && boxRows(companion.grid, 31).bottom === 5 && companion.grid.slice(2, 5).every(row => row.slice(slotLeft(companion.grid), slotLeft(companion.grid) + 9).every(cell => cell.c === '▀' || cell.c === '▄')))
  }
  console.log('§13 the small critter outside the cockpit keeps its neighbours in place')
  for (const cols of [178, 120]) {
    const inline = await capture(`inline-${cols}x29`, homeFor(`inline-${cols}`), cols, 29, [], 'ready ·', [], false, { MERCURY_FULLSCREEN: '0' })
    const lines = text(inline.grid)
    const r = lines.findIndex(row => /[▀▄]{9}/.test(row))
    const x = r < 0 ? -1 : lines[r]!.search(/[▀▄]{9}/)
    check(`${cols}×29: the inline sprite paints its complete three rows`, r >= 0 && lines.slice(r, r + 3).every(row => /^[▀▄]{9}$/.test(row.slice(x, x + 9))))
    const flourish = lines.find(row => row.includes('──') && /[▀▄]{9}/.test(row)) ?? ''
    const left = flourish.indexOf('──')
    const right = flourish.lastIndexOf('──')
    check(`${cols}×29: the inline sprite is centred between its flourishes`, left >= 0 && right > left && x === Math.round((left + right + 1 - 8) / 2), `sprite ${x}, flourishes ${left}..${right}`)
  }
  const deck = await capture('deck-99x29', homeFor('deck'), 120, 40, [{ requireAwait: true, awaitText: '⇧← back', awaitSettleTicks: 8, data: '', mark: 'wide-deck' }], 'ready ·', [{ afterMark: 'wide-deck', afterMs: 400, cols: 99, rows: 29 }], false, { MERCURY_HELM_HOME: '0', MERCURY_DECK_PANE: '1' })
  const deckLines = text(deck.grid)
  const deckRow = deckLines.findIndex(row => /[▀▄]{9}/.test(row))
  const deckX = deckRow < 0 ? -1 : deckLines[deckRow]!.search(/[▀▄]{9}/)
  check('99×29: the deck dock paints its complete three-row sprite', deckRow >= 0 && deckLines.slice(deckRow, deckRow + 3).every(row => /^[▀▄]{9}$/.test(row.slice(deckX, deckX + 9))))
  check('99×29: the deck sprite is centred in its existing thirteen-column slot', deckX === 4, `sprite column ${deckX}`)
} catch (error) {
  failures++
  console.log(`  [FAIL] drive — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  pending.closeAllConnections()
  pending.close()
  if (!mountsOnly) check('the working captures reached the local fixture', requests >= 3, `${requests} requests`)
  if (failures === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log(`  scratch kept for reading: ${scratch}`)
}

console.log(failures === 0 ? '\ncritter mini drive: GREEN' : `\ncritter mini drive: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
