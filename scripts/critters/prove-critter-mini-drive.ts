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
type Send = { data: string; targetText?: string; awaitText?: string; awaitSettleTicks?: number; afterPrevTicks?: number; minTick?: number; requireAwait?: boolean; mark?: string }
type Capture = { grid: Grid; marks: Record<string, Grid>; endReason: string }

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'critter-mini-'))
process.env.ANTHROPIC_API_KEY = KEY

const WRAP_VERB = 'Reading the complete fixture response and checking every part of it'
const STACK_VERB = 'Reading the whole fixture answer before replying'
const TALL_VERB = `${WRAP_VERB} against the recorded expectations before answering`
const GROW_VERB: Record<number, string> = { 120: 'Basking in the warm sun', 100: 'Basking in the sun' }

function homeFor(name: string, verb = name.startsWith('busy-') ? WRAP_VERB : undefined): { configHome: string; cwd: string } {
  const world = join(scratch, name)
  const cwd = join(world, 'fixture-cwd')
  const configHome = join(world, 'confighome')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configHome, { recursive: true })
  seedFirstRun(configHome, [cwd])
  if (verb !== undefined) writeFileSync(join(configHome, 'settings.json'), JSON.stringify({ spinnerVerbs: { mode: 'replace', verbs: [verb] } }))
  return { configHome, cwd }
}

const faceEnter: Send = { requireAwait: true, awaitText: '↑↓ choose', minTick: 35, awaitSettleTicks: 4, data: '\r' }
const onReady = (data: string, mark: string): Send => ({ requireAwait: true, awaitText: 'ready ·', targetText: '⇧← back', awaitSettleTicks: 6, data, mark })

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
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
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
    MERCURY_DOCTOR_STATE_DIR: join(scratch, 'doctor-state'),
    MERCURY_DAEMON_DIR: join(scratch, `${tag}-daemon`),
    MERCURY_TEAMS_DIR: join(scratch, 'teams'),
    MERCURY_CREW_DIR: join(scratch, 'crew'),
    MERCURY_TABULA_DIR: join(scratch, 'tabula'),
    MERCURY_HOME: join(scratch, 'proof-home'),
    ANTHROPIC_API_KEY: KEY,
    MERCURY_CUSTOM_OAUTH_URL: 'http://127.0.0.1:1',
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
function boxRows(g: Grid, left: number): { top: number; bottom: number } {
  const t = text(g)
  const header = rowWith(g, '✶ VIEW')
  let top = -1
  let bottom = -1
  for (let r = header + 1; r < t.length && r < header + 3; r++) if (t[r]![left] === '╭') { top = r; break }
  for (let r = top + 1; r < t.length && top >= 0; r++) if (t[r]![left] === '╰') { bottom = r; break }
  return { top, bottom }
}
function slotLeft(g: Grid): number {
  const header = rowWith(g, '✶ VIEW')
  const border = text(g)[header + 1] ?? ''
  return border.indexOf('╭') + 3
}

type Berth = { left: number; right: number; top: number; bottom: number; cardTop: number; cardBottom: number; cardLeft: number; x: number; y: number; cells: number }
function berthOf(g: Grid): Berth {
  const t = text(g)
  const border = t[rowWith(g, '✶ VIEW') + 1] ?? ''
  const left = border.indexOf('╭')
  const right = border.lastIndexOf('╮')
  const { top, bottom } = boxRows(g, left)
  const inner = t.slice(top + 1, bottom)
  const cardTop = inner.findIndex(row => row.indexOf('╭', left + 1) >= 0)
  const cardBottom = inner.findIndex(row => row.indexOf('╰', left + 1) >= 0)
  const cardLeft = inner.map(row => row.indexOf('╭', left + 1)).find(c => c >= 0) ?? -1
  const art: Array<[number, number]> = []
  for (let r = top + 1; r < bottom; r++) for (let c = left + 1; c < right; c++) if (g[r]![c]!.c === '▀') art.push([c, r])
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

function paneBottom(g: Grid, left: number, right: number): number {
  const t = text(g)
  for (let r = t.length - 1; r > 0; r--) if (t[r]![left] === '╰' && t[r]![right] === '╯') return r
  return -1
}
function stripBottom(g: Grid): number {
  const t = text(g)
  const strip = rowWith(g, '⊞ SESSIONS')
  if (strip < 0) return -1
  for (let r = strip + 1; r < t.length; r++) if (t[r]![0] === '╰') return r
  return -1
}

console.log('============================================================')
console.log(' the small critter in the slim session box and the SESSIONS bar — driven')
console.log('============================================================')

try {
  if (!mountsOnly) {
  const wide = homeFor('wide')
  const a = await capture('wide-a', wide, 178, 51, [onReady('/view on\r', 'boot'), onReady('/view off\r', 'bar'), onReady('/view\r', 'bar-off'), onReady('/view on\r', 'state')], '← back')
  const boot = a.marks['boot']!
  const bar = a.marks['bar']!
  const barOff = a.marks['bar-off']!
  const state = a.marks['state']!
  const barAgain = a.grid
  const b = await capture('wide-b', wide, 178, 51, [onReady('/view off\r', 'second-boot')], '← back')
  const secondBoot = b.marks['second-boot']!
  const offAfterSecondBoot = b.grid
  const band = await capture('band', homeFor('band'), 80, 21, [], '1 session on')
  const mid = homeFor('mid')
  const c = await capture('mid', mid, 120, 40, [onReady('/view on\r', 'boot')], '← back')
  const midBoot = c.marks['boot']!
  const midBar = c.grid
  const tripHome = homeFor('trip')
  writeFileSync(join(tripHome.configHome, 'settings.json'), JSON.stringify({ sessionsBar: true }))
  const trip = await capture('trip', tripHome, 178, 51, [onReady('', 'wide')], '← back', [{ atTick: 70, cols: 80, rows: 21 }, { atTick: 85, cols: 178, rows: 51 }])
  const tripWide = trip.marks['wide']!
  const tripNarrow = trip.marks['stage1:80x21']!
  const tripBack = trip.grid
  const tallHome = homeFor('tall')
  const tall = await capture('tall', tallHome, 80, 30, [{ requireAwait: true, awaitText: '1 session on', awaitSettleTicks: 6, data: '/view on\r', mark: 'boot' }], '1 session on')
  const tallBoot = tall.marks['boot']!
  const tallBar = tall.grid
  const CLICK_VIEW = '\x1b[<0;35;2M\x1b[<0;35;2m'
  const clickWorld = homeFor('click')
  const clicked = await capture('click', clickWorld, 178, 51, [
    onReady(CLICK_VIEW, 'boot'),
    { requireAwait: true, awaitText: '⊞ SESSIONS', awaitSettleTicks: 4, data: CLICK_VIEW, mark: 'click-bar' },
    { afterPrevTicks: 10, data: '', mark: 'click-off' },
  ], '← back')

  console.log('§1 the slim box at 178×51 (the one look; no setting)')
  const bx = boxRows(boot, 31)
  check('the header row ✶ VIEW stays at row 1', rowWith(boot, '✶ VIEW') === 1, `row ${rowWith(boot, '✶ VIEW')}`)
  check('the session box is five rows: border at row 2, border at row 6', bx.top === 2 && bx.bottom === 6, `top ${bx.top} bottom ${bx.bottom}`)
  let spriteDiff = 0
  const bootLeft = slotLeft(boot)
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(boot[3 + r]![bootLeft + col]!, band.grid[r]![2 + col]!)) spriteDiff++
  check('the three inner rows carry the band sprite at the slot\'s left (27 cells)', spriteDiff === 0, `${spriteDiff} cells differ, expected column ${bootLeft}`)
  check('the sprite cells at the slot\'s left are half-block glyphs', boot.slice(3, 6).every(row => row.slice(bootLeft, bootLeft + 9).every(cell => cell.c === '▀')))
  const ground = boot[7]![33]!.bg
  let tintOff = 0
  for (let r = 3; r <= 5; r++) for (let col = 32; col <= 145; col++) { if (col >= bootLeft && col < bootLeft + 9) continue; const cell = boot[r]![col]!; if (cell.c !== ' ' || cell.bg !== ground) tintOff++ }
  check('the rest of the three rows is the box’s own tint (blank cells on the pane ground)', tintOff === 0, `${tintOff} cells off`)
  check('nothing paints beside the idle sprite (no border glyph on its rows)', boot.slice(3, 6).every(row => !row.slice(43, 146).some(cell => cell.c === '╭' || cell.c === '│')))

  console.log('§2 the SESSIONS bar is not painted by default; its rows belong to the chat')
  check('no row of the frame reads ⊞ SESSIONS', rowWith(boot, '⊞ SESSIONS') === -1, `row ${rowWith(boot, '⊞ SESSIONS')}`)
  check('no row of the frame reads ▣ this session', rowWith(boot, '▣ this session') === -1)
  const paneOff = paneBottom(boot, 30, 147)
  const paneOn = paneBottom(bar, 30, 147)
  const stripOn = stripBottom(bar)
  check('the pane’s bottom border sits on the row the bar’s bottom border holds when it is on', paneOff === stripOn && stripOn === 44, `pane ${paneOff} strip ${stripOn}`)
  check('the ready row, the composer and the two hint rows stay where they are', text(boot).slice(45, 51).join('\n') === text(bar).slice(45, 51).join('\n'))
  check('the chat has four more inner rows with the bar off (37 for 33)', paneOff - paneOn === 4 && paneOff - bx.bottom - 1 === 37, `${paneOff} vs ${paneOn}`)

  console.log('§3 the landing form sits where the after frame shows it')
  check('the wordmark starts at row 9', text(boot)[9]!.includes('█▄▄▄█'))
  check('● ready at row 12', text(boot)[12]!.includes('● ready · type a prompt, or / for commands'))
  check('model · theme · dir at rows 14, 15, 16', text(boot)[14]!.includes('model') && text(boot)[15]!.includes('theme') && text(boot)[16]!.includes('dir'))
  check('the ↵ sends row at row 18', text(boot)[18]!.includes('❯ ↵ sends'))
  check('nothing is reworded: the landing rows read the same with the bar on, rows unmoved', text(boot).slice(9, 19).map(l => l.slice(30, 148)).join('\n') === text(bar).slice(9, 19).map(l => l.slice(30, 148)).join('\n'))

  console.log('§4 /view on paints the bar, /view off hides it, and bare /view answers the state')
  check('with the bar on the box stays five rows (border at 2, border at 6)', boxRows(bar, 31).top === 2 && boxRows(bar, 31).bottom === 6, `top ${boxRows(bar, 31).top} bottom ${boxRows(bar, 31).bottom}`)
  check('with the bar on the strip sits at row 42 and the pane’s bottom border at row 40', rowWith(bar, '⊞ SESSIONS') === 42 && paneOn === 40, `strip ${rowWith(bar, '⊞ SESSIONS')} pane ${paneOn}`)
  check('the bar carries the critter’s glyph, the model and the effort on its second row', /▗.*▖ │ Opus 5\.5 · ● high/.test(text(bar)[43] ?? ''), JSON.stringify(text(bar)[43]))
  check('the sprite stays the band sprite with the bar on (27 cells at the slot’s left)', bar.slice(3, 6).every(row => row.slice(slotLeft(bar), slotLeft(bar) + 9).every(cell => cell.c === '▀')))
  sameFrame('/view off after /view on repaints the default look cell for cell', barOff, boot)
  check('bare /view answers the state in one line under the composer', text(state).some(line => line.includes('SESSIONS bar off — /view on shows it')))
  check('bare /view changes nothing: the bar stays off', rowWith(state, '⊞ SESSIONS') === -1)
  check('/view on again paints the bar at the same rows', rowWith(barAgain, '⊞ SESSIONS') === 42 && paneBottom(barAgain, 30, 147) === 40)

  console.log('§5 the choice is kept across boots')
  check('a second boot of the same home lands with the saved bar on', rowWith(secondBoot, '⊞ SESSIONS') === 42 && paneBottom(secondBoot, 30, 147) === 40)
  sameFrame('/view off on the second boot repaints the default look cell for cell', offAfterSecondBoot, boot)

  console.log('§6 the same slim box and the same bar at 120×40')
  const midHeader = rowWith(midBoot, '✶ VIEW')
  const midLeft = text(midBoot)[midHeader + 1]!.indexOf('╭')
  const mx = boxRows(midBoot, midLeft)
  check('the box is five rows under the header', mx.top === midHeader + 1 && mx.bottom === midHeader + 5, `top ${mx.top} bottom ${mx.bottom}`)
  check('no row reads ⊞ SESSIONS by default', rowWith(midBoot, '⊞ SESSIONS') === -1)
  let midSprite = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(midBoot[mx.top + 1 + r]![slotLeft(midBoot) + col]!, band.grid[r]![2 + col]!)) midSprite++
  check('the sprite cells equal the band’s (27 cells)', midSprite === 0, `${midSprite} cells differ`)
  const mbx = boxRows(midBar, midLeft)
  check('/view on at 120×40 paints the bar and leaves the box five rows', mbx.bottom === midHeader + 5 && rowWith(midBar, '⊞ SESSIONS') >= 0, `bottom ${mbx.bottom} strip ${rowWith(midBar, '⊞ SESSIONS')}`)
  check('the bar’s bottom border row with the bar on is the pane’s bottom border row with it off', stripBottom(midBar) === paneBottom(midBoot, midLeft - 1, text(midBoot)[mx.top]!.lastIndexOf('╮') + 1), `${stripBottom(midBar)} vs ${paneBottom(midBoot, midLeft - 1, text(midBoot)[mx.top]!.lastIndexOf('╮') + 1)}`)

  console.log('§7 a resize from wide to narrow and back keeps the one sprite and the bar')
  let tripDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripWide[3 + r]![slotLeft(tripWide) + col]!, band.grid[r]![2 + col]!)) tripDiff++
  check('wide before the resize: the box carries the band’s sprite cells', tripDiff === 0, `${tripDiff} cells differ`)
  check('wide before the resize: the saved bar is on', rowWith(tripWide, '⊞ SESSIONS') === 42)
  let narrowDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripNarrow[r]![2 + col]!, band.grid[r]![2 + col]!)) narrowDiff++
  check('narrow: the 80×21 band paints the same sprite cells', narrowDiff === 0, `${narrowDiff} cells differ`)
  check('narrow: the compact layout paints no bar (it has no mount there)', rowWith(tripNarrow, '⊞ SESSIONS') === -1)
  sameFrame('wide again: the frame is the wide frame cell for cell, the bar back', tripBack, tripWide)

  console.log('§8 a compact window paints the one sprite; /view on holds without a bar to paint')
  let tallDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tallBoot[r]![2 + col]!, band.grid[r]![2 + col]!)) tallDiff++
  check('80×30: the band’s rows 0–2 carry the 80×21 sprite cells (27 cells)', tallDiff === 0, `${tallDiff} cells differ`)
  check('80×30: no half-block art below the three sprite rows', !tallBoot.slice(3, 7).some(row => row.slice(0, 16).some(cell => cell.c === '▀' || cell.c === '▄')))
  check('80×30 after /view on: the band and the sprite are unchanged and no bar row appears', tallBar.slice(0, 4).every((row, r) => row.every((cell, c) => sameCell(cell, tallBoot[r]![c]!))) && rowWith(tallBar, '⊞ SESSIONS') === -1)
  const tallSaved = (JSON.parse(readFileSync(join(tallHome.configHome, 'settings.json'), 'utf8')) as { sessionsBar?: boolean }).sessionsBar
  check('80×30 after /view on: the choice is saved for the wide layout', tallSaved === true, `sessionsBar ${String(tallSaved)}`)

  console.log('§9 the 80×21 band is untouched')
  check('the 80×21 band paints the dock sprite at rows 0–2, columns 2–10', band.grid.slice(0, 3).every(row => row.slice(2, 11).every(cell => cell.c === '▀')))
  check('the band’s status row reads 1 session on', rowWith(band.grid, '1 session on') === 20, `row ${rowWith(band.grid, '1 session on')}`)

  console.log('§10 the title reads ✶ VIEW, and a click on it shows and hides the bar and saves the choice')
  const clickBoot = clicked.marks['boot']!
  const clickBar = clicked.marks['click-bar']!
  const clickOff = clicked.marks['click-off']!
  check('every frame of the drive reads ✶ VIEW on row 1 and none reads ✶ SESSION', [boot, bar, midBoot, clickBoot, clickBar, clickOff].every(g => rowWith(g, '✶ VIEW') >= 0 && rowWith(g, '✶ SESSION') === -1) && rowWith(clickBoot, '✶ VIEW') === 1, `row ${rowWith(clickBoot, '✶ VIEW')}`)
  check('a click on VIEW paints the bar at row 42 and leaves the box five rows', rowWith(clickBar, '⊞ SESSIONS') === 42 && boxRows(clickBar, 31).top === 2 && boxRows(clickBar, 31).bottom === 6, `strip ${rowWith(clickBar, '⊞ SESSIONS')} top ${boxRows(clickBar, 31).top} bottom ${boxRows(clickBar, 31).bottom}`)
  check('a second click hides the bar again and the box stays five rows', rowWith(clickOff, '⊞ SESSIONS') === -1 && boxRows(clickOff, 31).top === 2 && boxRows(clickOff, 31).bottom === 6)
  let clickSprite = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(clickOff[3 + r]![slotLeft(clickOff) + col]!, band.grid[r]![2 + col]!)) clickSprite++
  check('the box carries the band’s sprite cells throughout (27 cells)', clickSprite === 0, `${clickSprite} cells differ`)
  const savedBar = (JSON.parse(readFileSync(join(clickWorld.configHome, 'settings.json'), 'utf8')) as { sessionsBar?: boolean }).sessionsBar
  check('the click saved the choice to the settings store (sessionsBar false after the second click)', savedBar === false, `sessionsBar ${String(savedBar)}`)
  console.log('§11 the small critter keeps the slot\'s left and the working card keeps its column')
  for (const [cols, rows] of [[178, 51], [120, 40], [100, 30]] as const) {
    const idle = cols === 178 ? boot : cols === 120 ? midBoot : (await capture('floor', homeFor('floor'), cols, rows, [], 'ready ·')).grid
    const border = text(idle)[rowWith(idle, '✶ VIEW') + 1]!
    const left = border.indexOf('╭')
    const bounds = boxRows(idle, left)
    const at = slotLeft(idle)
    check(`${cols}×${rows}: the idle sprite sits at the slot's left and fills the three inner rows`, bounds.bottom - bounds.top === 4 && idle.slice(bounds.top + 1, bounds.bottom).every(row => row.slice(at, at + 9).every(cell => cell.c === '▀')), `expected ${at},${bounds.top + 1}`)
    const busy = await capture(`busy-${cols}x${rows}`, homeFor(`busy-${cols}`), cols, rows, [onReady('hello fixture\r', 'idle')], 'first byte', [], true)
    const b = berthOf(busy.grid)
    check(`${cols}×${rows}: work paints beside the sprite`, b.cardLeft > left && b.cells === 27, `card ${b.cardLeft}, art cells ${b.cells}`)
    check(`${cols}×${rows}: the card keeps its column`, b.cardLeft === left + 16, `card ${b.cardLeft}, expected ${left + 16}`)
    check(`${cols}×${rows}: the busy sprite keeps the slot's left, its middle on the card's middle`, b.x === left + 3 && b.y === spriteTop(b), `sprite ${b.x},${b.y}; card ${b.cardTop}..${b.cardBottom} (${cardRows(b)} rows), expected ${left + 3},${spriteTop(b)}`)
  }
  console.log('§14 the sprite’s middle tracks the thinking box’s middle however tall the box grows')
  for (const [cols, rows] of [[120, 40], [100, 30]] as const) {
    const legs: Array<[string, string, number]> = [['one', 'Basking', 3], ['stack', STACK_VERB, 4], ['tall', TALL_VERB, 6]]
    for (const [leg, verb, expectedRows] of legs) {
      const shot = await capture(`level-${leg}-${cols}x${rows}`, homeFor(`level-${leg}-${cols}`, verb), cols, rows, [onReady('hello fixture\r', 'idle')], 'first byte', [], true)
      const b = berthOf(shot.grid)
      check(`${cols}×${rows} ${leg}: the thinking box is ${expectedRows} rows tall with the complete sprite beside it`, cardRows(b) === expectedRows && b.cells === 27 && b.bottom - b.top - 1 === expectedRows, `card ${b.cardTop}..${b.cardBottom} (${cardRows(b)} rows), box ${b.top}..${b.bottom}, art cells ${b.cells}`)
      check(`${cols}×${rows} ${leg}: the sprite’s middle is the box’s middle, the lower middle row for an even box (sprite rows ${spriteTop(b)}–${spriteTop(b) + 2})`, b.y === spriteTop(b), `sprite top ${b.y}, expected ${spriteTop(b)}`)
      check(`${cols}×${rows} ${leg}: no sprite row lies beside the box’s top border unless the box is three rows`, expectedRows === 3 || b.y > b.cardTop, `sprite rows ${b.y}–${b.y + 2}, top border ${b.cardTop}`)
    }
    const wide = cols + 10
    const grow = await capture(`grow-${cols}x${rows}`, homeFor(`grow-${cols}`, GROW_VERB[cols]!), wide, rows, [
      onReady('hello fixture\r', 'idle'),
      { requireAwait: true, awaitText: GROW_VERB[cols]!, awaitSettleTicks: 5, data: '', mark: 'one-line' },
    ], '│ (', [{ afterMark: 'one-line', afterMs: 400, cols, rows }], true)
    const before = berthOf(grow.marks[`stage0:${wide}x${rows}`]!)
    const after = berthOf(grow.grid)
    console.log(`  ${cols}×${rows} grow: the box is ${cardRows(before)} rows at ${wide} columns and ${cardRows(after)} rows at ${cols} (sprite top ${before.y} → ${after.y})`)
    check(`${cols}×${rows} grow: at ${wide} columns the status fits one line and the box is three rows`, cardRows(before) === 3 && before.cells === 27 && before.y === before.cardTop, `card ${before.cardTop}..${before.cardBottom} (${cardRows(before)} rows), sprite top ${before.y}, art cells ${before.cells}`)
    check(`${cols}×${rows} grow: at ${cols} columns the meta stacks and the box is four rows`, cardRows(after) === 4 && after.cells === 27, `card ${after.cardTop}..${after.cardBottom} (${cardRows(after)} rows), art cells ${after.cells}`)
    check(`${cols}×${rows} grow: once the stats stack the sprite sits on the box’s lower three rows (the verb line, the stats, the bottom border)`, after.y === after.cardTop + 1, `sprite top ${after.y}, card top ${after.cardTop}`)
    check(`${cols}×${rows} grow: the sprite moves down one row as the box grows from three rows to four, its middle following the box’s middle`, after.y === before.y + 1 && before.cardTop === after.cardTop, `sprite top ${before.y} → ${after.y}, card top ${before.cardTop} → ${after.cardTop}`)
  }
  }
  console.log('§13 the small critter outside the cockpit keeps its neighbours in place')
  for (const cols of [178, 120]) {
    const inline = await capture(`inline-${cols}x29`, homeFor(`inline-${cols}`), cols, 29, [], 'ready ·', [], false, { MERCURY_FULLSCREEN: '0' })
    const lines = text(inline.grid)
    const r = lines.findIndex(row => row.includes('▀'.repeat(9)))
    const x = r < 0 ? -1 : lines[r]!.indexOf('▀'.repeat(9))
    check(`${cols}×29: the inline sprite paints its complete three rows`, r >= 0 && lines.slice(r, r + 3).every(row => row.slice(x, x + 9) === '▀'.repeat(9)))
    const flourish = lines.find(row => row.includes('──') && row.includes('▀'.repeat(9))) ?? ''
    const left = flourish.indexOf('──')
    const right = flourish.lastIndexOf('──')
    check(`${cols}×29: the inline sprite is centred between its flourishes`, left >= 0 && right > left && x === Math.round((left + right + 1 - 8) / 2), `sprite ${x}, flourishes ${left}..${right}`)
  }
  const deck = await capture('deck-99x29', homeFor('deck'), 120, 40, [{ requireAwait: true, awaitText: '⇧← back', awaitSettleTicks: 8, data: '', mark: 'wide-deck' }], 'ready ·', [{ afterMark: 'wide-deck', afterMs: 400, cols: 99, rows: 29 }], false, { MERCURY_HELM_HOME: '0', MERCURY_DECK_PANE: '1' })
  const deckLines = text(deck.grid)
  const deckRow = deckLines.findIndex(row => row.includes('▀'.repeat(9)))
  const deckX = deckRow < 0 ? -1 : deckLines[deckRow]!.indexOf('▀'.repeat(9))
  check('99×29: the deck dock paints its complete three-row sprite', deckRow >= 0 && deckLines.slice(deckRow, deckRow + 3).every(row => row.slice(deckX, deckX + 9) === '▀'.repeat(9)))
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
