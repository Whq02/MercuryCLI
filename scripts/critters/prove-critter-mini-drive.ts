#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { keyHintLabel } from '../../src/screen/widgets/keyHintLabel.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'
import { compactGrid, DEFAULT_MASKS, firstDivergence, type StoredGrid } from '../ui/visualBaseline.ts'
import { BOOT_FACE_READY } from '../lib/bootFace.ts'

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
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}${!cond ? ' — change: the mini critter sprite in src/screen/widgets/MiniCritter.tsx or the layout that places it; rerun with --frames <dir> to write every captured grid as a .txt file and read the failing frame' : ''}`)
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
const WIDE_STACK_VERB = 'Reading the whole fixture answer once again before replying'
const ONE_LINE_COLS = 130
const verbFor = (cols: number): string => (cols >= 120 ? WIDE_STACK_VERB : STACK_VERB)

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

const faceEnter: Send = { requireAwait: true, awaitText: '↑↓', awaitPattern: BOOT_FACE_READY, minTick: 10, awaitSettleTicks: 6, data: '\r' }
const WAY_BACK = keyHintLabel('⇧← back')
const onReady = (data: string, mark: string): Send => ({ requireAwait: true, awaitText: 'ready ·', awaitPattern: '(?:^|\\n) ?ready ·', targetText: WAY_BACK, awaitSettleTicks: 6, data, mark })

type Resize = { atTick?: number; afterMark?: string; afterMs?: number; cols: number; rows: number }
async function capture(tag: string, world: { configHome: string; cwd: string }, cols: number, rows: number, sends: Send[], readyText: string, resizes: Resize[] = [], live = false, envPatch: Record<string, string> = {}): Promise<Capture> {
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, DIST], cwd: world.cwd, sends: [faceEnter, ...sends], readyText: readyText === 'ready ·' ? [readyText, WAY_BACK] : [readyText], readySettleTicks: 8, stableTicks: live ? 0 : 4, total: 400, cols, rows, out, resizes }))
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
  const regions: Array<[number, number, number, number]> = [[0, 5, 30, 178], [5, bottom, 148, 178], [bottom, 51, 0, 178], [7, 16, 30, 148]]
  let off = 0
  let first = ''
  for (const [r0, r1, c0, c1] of regions) for (let r = r0; r < r1; r++) for (let c = c0; c < c1; c++) {
    if (sameCell(a[r]![c]!, b[r]![c]!)) continue
    off++
    if (!first) first = `row ${r} col ${c}: ${JSON.stringify(a[r]![c]!.c)} vs ${JSON.stringify(b[r]![c]!.c)}`
  }
  check(label, off === 0 && paneBottom(a, 30, 147) === bottom, `${off} cells differ (${first}); pane bottom ${paneBottom(a, 30, 147)} vs ${bottom}`)
}
function bandRows(g: Grid): { top: number; bottom: number } {
  const t = text(g)
  const paneLeft = (t[0] ?? '').indexOf('╭')
  const paneRight = (t[0] ?? '').lastIndexOf('╮')
  if (paneLeft < 0 || paneRight < 0) return { top: -1, bottom: -1 }
  for (let r = 1; r < t.length; r++) {
    if (/^ ─+ $/.test(t[r]!.slice(paneLeft + 1, paneRight))) return { top: 1, bottom: r }
  }
  return { top: -1, bottom: -1 }
}
function berthLeft(g: Grid): number {
  return (text(g)[0] ?? '').indexOf('╭') + 1
}
function slotLeft(g: Grid): number {
  return berthLeft(g) + 3
}

type Berth = { left: number; right: number; top: number; bottom: number; workTop: number; workBottom: number; workLeft: number; x: number; y: number; cells: number }
function berthOf(g: Grid): Berth {
  const t = text(g)
  const paneLeft = (t[0] ?? '').indexOf('╭')
  const paneRight = (t[0] ?? '').lastIndexOf('╮')
  const left = paneLeft + 1
  const right = paneRight - 1
  const { top, bottom } = bandRows(g)
  const workFrom = left + 15
  const workLines: number[] = []
  let workLeft = -1
  for (let r = top; r < bottom && top >= 0; r++) {
    const slice = t[r]!.slice(workFrom, right + 1)
    if (slice.trim() === '') continue
    workLines.push(r)
    const first = slice.search(/\S/)
    if (first >= 0) workLeft = workLeft < 0 ? workFrom + first : Math.min(workLeft, workFrom + first)
  }
  const art: Array<[number, number]> = []
  for (let r = top; r < bottom && top >= 0; r++) for (let c = left; c <= right; c++) if (g[r]![c]!.c === '▀' || g[r]![c]!.c === '▄') art.push([c, r])
  return {
    left, right, top, bottom,
    workTop: workLines.length ? workLines[0]! : -1,
    workBottom: workLines.length ? workLines[workLines.length - 1]! : -1,
    workLeft,
    x: art.length ? Math.min(...art.map(cell => cell[0])) : -1,
    y: art.length ? Math.min(...art.map(cell => cell[1])) : -1,
    cells: art.length,
  }
}
const workRows = (b: Berth): number => b.workTop < 0 ? 0 : b.workBottom - b.workTop + 1
const bandInnerRows = (b: Berth): number => b.top < 0 ? 0 : b.bottom - b.top
const spriteTop = (b: Berth): number => b.top + Math.ceil((bandInnerRows(b) - 3) / 2)
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
  const a = await capture('wide-a', wide, 178, 51, [onReady('/view on\r', 'boot')], 'Unknown command')
  const boot = a.marks['boot']!
  const typed = a.grid
  const band = await capture('band', homeFor('band'), 80, 21, [], '1 session on')
  const mid = homeFor('mid')
  const c = await capture('mid', mid, 120, 40, [onReady('', 'boot')], '← back')
  const midBoot = c.marks['boot']!
  const trip = await capture('trip', homeFor('trip'), 178, 51, [onReady('', 'wide')], '← back', [{ afterMark: 'wide', afterMs: 400, cols: 80, rows: 21 }, { afterMark: 'wide', afterMs: 4400, cols: 178, rows: 51 }])
  const tripWide = trip.marks['wide']!
  const tripNarrow = trip.marks['stage1:80x21']!
  const tripBack = trip.grid
  const tall = await capture('tall', homeFor('tall'), 80, 30, [{ requireAwait: true, awaitText: '1 session on', awaitSettleTicks: 6, data: '', mark: 'boot' }], '1 session on')
  const tallBoot = tall.marks['boot']!

  console.log('§1 the borderless band at 178×51 (the one look; no setting), the pane\'s first interior row')
  const bx = bandRows(boot)
  check('no title row paints above the band: the pane\'s top border is row 0 and nothing reads ✶ VIEW', rowWith(boot, '✶ VIEW') === -1 && text(boot)[0]!.includes('╭'), `row ${rowWith(boot, '✶ VIEW')}`)
  check('the status band is four rows under the pane\'s top border: sprite rows 1–3, hairline at row 4', bx.top === 1 && bx.bottom === 4, `top ${bx.top} bottom ${bx.bottom}`)
  let spriteDiff = 0
  const bootLeft = slotLeft(boot)
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(boot[1 + r]![bootLeft + col]!, band.grid[r]![2 + col]!)) spriteDiff++
  check('the three inner rows carry the band sprite at the slot\'s left (27 cells)', spriteDiff === 0, `${spriteDiff} cells differ, expected column ${bootLeft}`)
  check('the sprite cells at the slot\'s left are half-block glyphs', boot.slice(1, 4).every(row => row.slice(bootLeft, bootLeft + 9).every(cell => cell.c === '▀' || cell.c === '▄')))
  const ground = boot[5]![33]!.bg
  let tintOff = 0
  for (let r = 1; r <= 3; r++) for (let col = 31; col <= 146; col++) { if (col >= bootLeft && col < bootLeft + 9) continue; const cell = boot[r]![col]!; if (cell.c !== ' ' || cell.bg !== ground) tintOff++ }
  check('the rest of the three rows is blank on the pane ground', tintOff === 0, `${tintOff} cells off`)
  check('nothing paints beside the idle sprite (no border glyph on its rows)', boot.slice(1, 4).every(row => !row.slice(43, 146).some(cell => cell.c === '╭' || cell.c === '│')))

  console.log('§2 no SESSIONS bar paints under the view; the view reaches the status row')
  check('no row of the frame reads ⊞ SESSIONS', rowWith(boot, '⊞ SESSIONS') === -1, `row ${rowWith(boot, '⊞ SESSIONS')}`)
  check('no row of the frame reads ▣ this session', rowWith(boot, '▣ this session') === -1)
  const paneOff = paneBottom(boot, 30, 147)
  check('the pane’s bottom border sits on row 45, directly above the status row', paneOff === 45 && text(boot)[46]!.includes('ready ·'), `pane ${paneOff}`)
  check('the chat has forty inner rows under the band', paneOff - bx.bottom - 1 === 40, `${paneOff} vs ${bx.bottom}`)

  console.log('§3 the landing form sits under the band')
  check('the wordmark starts three rows under the band', text(boot)[bx.bottom + 3]!.includes('█▄▄▄█'))
  check('model · dir · memory sit seven, eight and nine rows under the band (no critter row)', text(boot)[bx.bottom + 7]!.includes('model') && text(boot)[bx.bottom + 8]!.includes('dir') && text(boot)[bx.bottom + 9]!.includes('memory') && !text(boot).slice(bx.bottom + 1, bx.bottom + 12).some(row => row.includes('critter')))
  check('the command hints follow their blank line', text(boot)[bx.bottom + 11]!.includes('/crewmates  /saturn  /health  /trace'))

  console.log('§4 /view is an unknown command like any other')
  check('typed, /view on answers the ordinary unknown-command line', rowWith(typed, 'Unknown command: /view') >= 0)
  check('…and paints no bar, the band stays four rows and the pane keeps its bottom border', rowWith(typed, '⊞ SESSIONS') === -1 && bandRows(typed).top === 1 && bandRows(typed).bottom === 4 && paneBottom(typed, 30, 147) === 45)
  sameLook('the answer repaints nothing outside the chat’s own rows', typed, boot)

  console.log('§6 the same borderless band at 120×40')
  const midLeft = berthLeft(midBoot)
  const mx = bandRows(midBoot)
  check('the band is four rows under the pane’s top border', mx.top === 1 && mx.bottom === 4, `top ${mx.top} bottom ${mx.bottom}`)
  check('no row reads ⊞ SESSIONS or ✶ VIEW', rowWith(midBoot, '⊞ SESSIONS') === -1 && rowWith(midBoot, '✶ VIEW') === -1)
  let midSprite = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(midBoot[mx.top + r]![slotLeft(midBoot) + col]!, band.grid[r]![2 + col]!)) midSprite++
  check('the sprite cells equal the band’s (27 cells)', midSprite === 0, `${midSprite} cells differ`)
  const midBottom = paneBottom(midBoot, midLeft - 1, text(midBoot)[0]!.lastIndexOf('╮'))
  check('the pane’s bottom border sits directly above the status row', midBottom >= 0 && text(midBoot)[midBottom + 1]!.includes('ready ·'), `pane ${midBottom}`)

  console.log('§7 a resize from wide to narrow and back keeps the one sprite')
  let tripDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripWide[1 + r]![slotLeft(tripWide) + col]!, band.grid[r]![2 + col]!)) tripDiff++
  check('wide before the resize: the band carries the compact-band sprite cells', tripDiff === 0, `${tripDiff} cells differ`)
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

  console.log('§11 the small critter keeps the slot\'s left and the unboxed work column keeps its column')
  for (const [cols, rows] of [[178, 51], [120, 40], [100, 30]] as const) {
    const idle = cols === 178 ? boot : cols === 120 ? midBoot : (await capture('floor', homeFor('floor'), cols, rows, [], 'ready ·')).grid
    const left = berthLeft(idle)
    const bounds = bandRows(idle)
    const at = slotLeft(idle)
    check(`${cols}×${rows}: the idle sprite sits at the slot's left and fills the three band rows`, bounds.bottom - bounds.top === 3 && idle.slice(bounds.top, bounds.bottom).every(row => row.slice(at, at + 9).every(cell => cell.c === '▀' || cell.c === '▄')), `expected ${at},${bounds.top}`)
    const busy = await capture(`busy-${cols}x${rows}`, homeFor(`busy-${cols}`), cols, rows, [onReady('hello fixture\r', 'idle')], 'gives up after', [], true)
    const b = berthOf(busy.grid)
    check(`${cols}×${rows}: work paints beside the sprite`, b.workLeft > left && b.cells === 27, `work ${b.workLeft}, art cells ${b.cells}`)
    check(`${cols}×${rows}: the work column keeps its left`, b.workLeft === left + 16, `work ${b.workLeft}, expected ${left + 16}`)
    check(`${cols}×${rows}: the busy sprite keeps the slot's left, its middle on the band's middle`, b.x === left + 3 && b.y === spriteTop(b), `sprite ${b.x},${b.y}; band ${b.top}..${b.bottom - 1} (${bandInnerRows(b)} rows), work ${b.workTop}..${b.workBottom} (${workRows(b)} rows), expected ${left + 3},${spriteTop(b)}`)
  }
  console.log('§14 the sprite’s middle tracks the band’s middle however tall the unboxed work grows')
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    const legs: Array<[string, string, number, number]> = [['one', verbFor(cols), 1, ONE_LINE_COLS], ['stack', verbFor(cols), 2, cols], ['tall', TALL_VERB, cols === 120 ? 3 : 4, cols]]
    for (const [leg, verb, expectedWorkRows, legCols] of legs) {
      const shot = await capture(`level-${leg}-${cols}x${rows}`, homeFor(`level-${leg}-${cols}`, verb), legCols, rows, [onReady('hello fixture\r', 'idle')], 'gives up after', [], true)
      const b = berthOf(shot.grid)
      const expectedBand = Math.max(3, expectedWorkRows)
      check(`${legCols}×${rows} ${leg}: the unboxed work is ${expectedWorkRows} row(s) tall inside a ${expectedBand}-row band with the complete sprite beside it`, workRows(b) === expectedWorkRows && b.cells === 27 && bandInnerRows(b) === expectedBand, `work ${b.workTop}..${b.workBottom} (${workRows(b)} rows), band ${b.top}..${b.bottom} (${bandInnerRows(b)} inner rows), art cells ${b.cells}`)
      check(`${legCols}×${rows} ${leg}: the sprite’s middle is the band’s middle, the lower middle row for an even band (sprite rows ${spriteTop(b)}–${spriteTop(b) + 2})`, b.y === spriteTop(b), `sprite top ${b.y}, expected ${spriteTop(b)}`)
    }
    const grow = await capture(`grow-${cols}x${rows}`, homeFor(`grow-${cols}`, TALL_VERB), 120, rows, [
      onReady('hello fixture\r', 'idle'),
      { requireAwait: true, awaitText: 'gives up after', awaitSettleTicks: 5, data: '', mark: 'three-row' },
    ], 'gives up after', [{ afterMark: 'three-row', afterMs: 400, cols: 100, rows }], true)
    const before = berthOf(grow.marks[`stage0:120x${rows}`]!)
    const after = berthOf(grow.grid)
    console.log(`  ${cols}×${rows} grow: the band is ${bandInnerRows(before)} rows at 120 columns and ${bandInnerRows(after)} rows at 100 (sprite top ${before.y} → ${after.y})`)
    check(`${cols}×${rows} grow: at 120 columns the tall work is three rows and the sprite sits on rows 1–3`, workRows(before) === 3 && bandInnerRows(before) === 3 && before.cells === 27 && before.y === before.top, `work ${workRows(before)}, band ${bandInnerRows(before)}, sprite top ${before.y}, art cells ${before.cells}`)
    check(`${cols}×${rows} grow: at 100 columns the tall work wraps to four rows and the band grows to four rows`, workRows(after) === 4 && bandInnerRows(after) === 4 && after.cells === 27, `work ${workRows(after)}, band ${bandInnerRows(after)}, art cells ${after.cells}`)
    check(`${cols}×${rows} grow: the sprite moves down one row as the band grows from three rows to four, its middle following the band’s middle`, after.y === before.y + 1 && after.y === spriteTop(after), `sprite top ${before.y} → ${after.y}`)
  }
  console.log('§12 /critter opens the picker with the four-row list and one live sprite, at 178 and at 60 columns')
  const pickerWide = await capture('picker-178x51', homeFor('picker-178'), 178, 51, [onReady('/critter\r', 'landing')], 'Session theme')
  const pickerNarrow = await capture('picker-60x40', homeFor('picker-60'), 60, 40, [{ requireAwait: true, awaitText: keyHintLabel('⇧← concourse'), awaitSettleTicks: 6, data: '/critter\r', mark: 'landing' }], 'Session theme')
  for (const [cols, shot] of [[178, pickerWide], [60, pickerNarrow]] as const) {
    const lines = text(shot.grid)
    const rows = ['[1] crab', '[2] octopus', '[3] jellyfish', '[4] clam'].map(name => lines.findIndex(line => line.includes(name)))
    check(`${cols} columns: the four rows paint in order with [1]–[4]`, rows.every(r => r >= 0) && rows[0]! < rows[1]! && rows[1]! < rows[2]! && rows[2]! < rows[3]!, rows.join(','))
    const artRows = rows[0]! >= 0 ? lines.slice(rows[0]!, rows[0]! + 3).filter(line => /[▀▄]{9}/.test(line)).length : 0
    check(`${cols} columns: one live 3×9 sprite paints beside the list and the active row marks current`, artRows === 3 && rows.some(r => r >= 0 && lines[r]!.includes('current')) && rows.some(r => r >= 0 && lines[r]!.includes('❯ ')), `artRows=${artRows}`)
    check(`${cols} columns: the landing before /critter carries the box sprite alone`, !text(shot.marks['landing']!).some(line => line.includes('[1] crab')))
  }
  const companion = await capture('companion-178x51', homeFor('companion-178'), 178, 51, [onReady('/companion tip\r', 'landing'), { requireAwait: true, awaitText: 'Unknown command', awaitSettleTicks: 6, data: '', mark: 'answer' }], 'Unknown command')
  check('/companion is no command: the chat answers Unknown command and no tip line paints', rowWith(companion.grid, 'Unknown command: /companion') >= 0 && rowWith(companion.grid, 'tip —') === -1, `row ${rowWith(companion.grid, 'Unknown command: /companion')}`)
  check('/companion leaves the band four rows with the sprite alone', bandRows(companion.grid).top === 1 && bandRows(companion.grid).bottom === 4 && companion.grid.slice(1, 4).every(row => row.slice(slotLeft(companion.grid), slotLeft(companion.grid) + 9).every(cell => cell.c === '▀' || cell.c === '▄')))
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
  const deck = await capture('deck-99x29', homeFor('deck'), 120, 40, [{ requireAwait: true, awaitText: WAY_BACK, awaitSettleTicks: 8, data: '', mark: 'wide-deck' }], 'ready ·', [{ afterMark: 'wide-deck', afterMs: 400, cols: 99, rows: 29 }], false, { MERCURY_HELM_HOME: '0', MERCURY_DECK_PANE: '1' })
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
  if (!mountsOnly) check('the working captures reached the local fixture', requests >= 3, `${requests} requests; the busy captures send hello fixture to ANTHROPIC_BASE_URL (the local fixture server in this file), so see whether the busy captures reached their first byte`)
  if (failures === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log(`  scratch kept for reading: ${scratch}`)
}

console.log(failures === 0 ? '\ncritter mini drive: GREEN' : `\ncritter mini drive: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
