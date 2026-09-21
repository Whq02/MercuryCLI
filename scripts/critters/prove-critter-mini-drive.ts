#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedFirstRun } from '../lib/firstRunSeed.ts'
import { vshotBudgetMs } from '../lib/captureDriver.ts'

const ROOT = resolve(import.meta.dir, '../..')
const DIST = join(ROOT, 'dist/mercury.mjs')
const VSHOT = join(ROOT, 'scripts/ui/vshot.py')
const VENDORED_NODE = join(ROOT, 'dist/vendor/node/bin/node')
const NODE = existsSync(VENDORED_NODE) ? VENDORED_NODE : 'node'
const DEAD = 'http://127.0.0.1:9'
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
type Send = { data: string; awaitText?: string; awaitSettleTicks?: number; afterPrevTicks?: number; minTick?: number; requireAwait?: boolean; mark?: string }
type Capture = { grid: Grid; marks: Record<string, Grid>; endReason: string }

const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'critter-mini-'))
process.env.ANTHROPIC_API_KEY = KEY

function homeFor(name: string): { configHome: string; cwd: string } {
  const world = join(scratch, name)
  const cwd = join(world, 'fixture-cwd')
  const configHome = join(world, 'confighome')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(configHome, { recursive: true })
  seedFirstRun(configHome, [cwd])
  return { configHome, cwd }
}

const faceEnter: Send = { requireAwait: true, awaitText: '↑↓ choose', minTick: 35, awaitSettleTicks: 4, data: '\r' }
const onReady = (data: string, mark: string): Send => ({ requireAwait: true, awaitText: '· ready', awaitSettleTicks: 6, data, mark })

type Resize = { atTick: number; cols: number; rows: number }
async function capture(tag: string, world: { configHome: string; cwd: string }, cols: number, rows: number, sends: Send[], readyText: string, resizes: Resize[] = []): Promise<Capture> {
  const out = join(scratch, `${tag}.json`)
  const cfgPath = join(scratch, `${tag}-cfg.json`)
  writeFileSync(cfgPath, JSON.stringify({ argv: [NODE, DIST], cwd: world.cwd, sends: [faceEnter, ...sends], readyText: [readyText], readySettleTicks: 4, stableTicks: 4, total: 400, cols, rows, out, resizes }))
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
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_LIVE_CLOCK: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_CRITTER_SLEEP: '0',
    MERCURY_DECK_COMPANION: '0',
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
  return { grid: payload.grid, marks, endReason: payload.endReason }
}

const text = (g: Grid): string[] => g.map(row => row.map(c => c.c).join(''))
const rowWith = (g: Grid, needle: string): number => text(g).findIndex(line => line.includes(needle))
const sameCell = (a: Cell, b: Cell): boolean => a.c === b.c && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.rev === b.rev
function cellDiff(a: Grid, b: Grid): number {
  let n = 0
  for (let r = 0; r < Math.max(a.length, b.length); r++) {
    const ra = a[r] ?? []
    const rb = b[r] ?? []
    for (let c = 0; c < Math.max(ra.length, rb.length); c++) {
      const x = ra[c]
      const y = rb[c]
      if (x === undefined || y === undefined || !sameCell(x, y)) n++
    }
  }
  return n
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
console.log(' the small critter in the slim session box — driven')
console.log('============================================================')

try {
  const wide = homeFor('wide')
  const a = await capture('wide-a', wide, 178, 51, [onReady('/critter on\r', 'boot'), onReady('/critter off\r', 'full'), onReady('/critter\r', 'mini-again')], '· ready')
  const boot = a.marks['boot']!
  const full = a.marks['full']!
  const miniAgain = a.marks['mini-again']!
  const fullAgain = a.grid
  const b = await capture('wide-b', wide, 178, 51, [onReady('/critter\r', 'second-boot')], '· ready')
  const secondBoot = b.marks['second-boot']!
  const miniAfterSecondBoot = b.grid
  const band = await capture('band', homeFor('band'), 80, 21, [], '1 session on')
  const mid = homeFor('mid')
  const c = await capture('mid', mid, 120, 40, [onReady('/critter\r', 'boot')], '· ready')
  const midBoot = c.marks['boot']!
  const midFull = c.grid
  const trip = await capture('trip', homeFor('trip'), 178, 51, [onReady('', 'wide')], '· ready', [{ atTick: 70, cols: 80, rows: 21 }, { atTick: 85, cols: 178, rows: 51 }])
  const tripWide = trip.marks['wide']!
  const tripNarrow = trip.marks['stage1:80x21']!
  const tripBack = trip.grid
  const tall = await capture('tall', homeFor('tall'), 80, 30, [{ requireAwait: true, awaitText: '1 session on', awaitSettleTicks: 6, data: '/critter\r', mark: 'boot' }], '1 session on')
  const tallBoot = tall.marks['boot']!
  const tallFull = tall.grid
  const CLICK_VIEW = '\x1b[<0;35;2M\x1b[<0;35;2m'
  const clickWorld = homeFor('click')
  const clicked = await capture('click', clickWorld, 178, 51, [
    onReady(CLICK_VIEW, 'boot'),
    { requireAwait: true, awaitText: '▄▄▀▀▀▀▀▀▄▄', awaitSettleTicks: 4, data: CLICK_VIEW, mark: 'click-full' },
    { afterPrevTicks: 10, data: '', mark: 'click-mini' },
  ], '· ready')

  console.log('§1 the slim box at 178×51 with the design on (absent setting)')
  const bx = boxRows(boot, 31)
  check('the header row ✶ VIEW stays at row 1', rowWith(boot, '✶ VIEW') === 1, `row ${rowWith(boot, '✶ VIEW')}`)
  check('the session box is five rows: border at row 2, border at row 6', bx.top === 2 && bx.bottom === 6, `top ${bx.top} bottom ${bx.bottom}`)
  let spriteDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(boot[3 + r]![34 + col]!, band.grid[r]![2 + col]!)) spriteDiff++
  check('the three inner rows carry the 80×21 band’s sprite cells two columns in (glyph, fg, bg — 27 cells)', spriteDiff === 0, `${spriteDiff} cells differ`)
  check('the sprite cells are half-block glyphs', boot.slice(3, 6).every(row => row.slice(34, 43).every(cell => cell.c === '▀')))
  const ground = boot[7]![33]!.bg
  let tintOff = 0
  for (let r = 3; r <= 5; r++) for (let col = 32; col <= 145; col++) { if (col >= 34 && col <= 42) continue; const cell = boot[r]![col]!; if (cell.c !== ' ' || cell.bg !== ground) tintOff++ }
  check('the rest of the three rows is the box’s own tint (blank cells on the pane ground)', tintOff === 0, `${tintOff} cells off`)
  check('the companion bubble is silent here (no border glyph beside the sprite)', boot.slice(3, 6).every(row => !row.slice(43, 146).some(cell => cell.c === '╭' || cell.c === '│')))

  console.log('§2 the SESSIONS strip is not painted; its rows belong to the chat')
  check('no row of the frame reads ⊞ SESSIONS', rowWith(boot, '⊞ SESSIONS') === -1, `row ${rowWith(boot, '⊞ SESSIONS')}`)
  check('no row of the frame reads ▣ this session', rowWith(boot, '▣ this session') === -1)
  const paneMini = paneBottom(boot, 30, 147)
  const paneFull = paneBottom(full, 30, 147)
  const stripFull = stripBottom(full)
  check('the pane’s bottom border sits on the row the strip’s bottom border held', paneMini === stripFull && stripFull === 44, `pane ${paneMini} strip ${stripFull}`)
  check('the ready row, the composer and the two hint rows stay where they are', text(boot).slice(45, 51).join('\n') === text(full).slice(45, 51).join('\n'))
  const chatMini = paneMini - bx.bottom - 1
  const chatFull = paneFull - boxRows(full, 31).bottom - 1
  check('the chat has ten more inner rows (37 for 27)', chatMini - chatFull === 10 && chatMini === 37, `${chatMini} vs ${chatFull}`)

  console.log('§3 the landing form sits where the after frame shows it')
  check('the wordmark starts at row 9', text(boot)[9]!.includes('█▄▄▄█'))
  check('● ready at row 12', text(boot)[12]!.includes('● ready · type a prompt, or / for commands'))
  check('model · theme · dir at rows 14, 15, 16', text(boot)[14]!.includes('model') && text(boot)[15]!.includes('theme') && text(boot)[16]!.includes('dir'))
  check('the ↵ sends row at row 18', text(boot)[18]!.includes('❯ ↵ sends'))
  check('nothing is reworded: the landing rows read the same in both forms, six rows higher', text(boot).slice(9, 19).map(l => l.slice(30, 148)).join('\n') === text(full).slice(15, 25).map(l => l.slice(30, 148)).join('\n'))

  console.log('§4 /critter on paints the shipped look, /critter off the design, and bare /critter toggles')
  const fx = boxRows(full, 31)
  check('with full the box is eleven rows (border at 2, border at 12)', fx.top === 2 && fx.bottom === 12, `top ${fx.top} bottom ${fx.bottom}`)
  check('with full the strip is back at row 42 and the pane’s bottom border at row 40', rowWith(full, '⊞ SESSIONS') === 42 && paneFull === 40, `strip ${rowWith(full, '⊞ SESSIONS')} pane ${paneFull}`)
  check('with full the wordmark starts at row 15 and the ↵ sends row sits at row 24', text(full)[15]!.includes('█▄▄▄█') && text(full)[24]!.includes('❯ ↵ sends'))
  check('with full the hero art paints in the box (a ▄▄ crown row above the sprite rows)', text(full)[5]!.includes('▄▄▀▀▀▀▀▀▄▄'))
  check('/critter off after /critter on repaints the design cell for cell', cellDiff(miniAgain, boot) === 0, `${cellDiff(miniAgain, boot)} cells differ`)
  check('bare /critter after that toggles to the shipped look cell for cell', cellDiff(fullAgain, full) === 0, `${cellDiff(fullAgain, full)} cells differ`)

  console.log('§5 the choice is kept across boots')
  check('a second boot of the same home lands on the saved full look', cellDiff(secondBoot, full) === 0, `${cellDiff(secondBoot, full)} cells differ`)
  check('/critter on the second boot repaints the design cell for cell', cellDiff(miniAfterSecondBoot, boot) === 0, `${cellDiff(miniAfterSecondBoot, boot)} cells differ`)

  console.log('§6 the same slim box at 120×40')
  const midHeader = rowWith(midBoot, '✶ VIEW')
  const midLeft = text(midBoot)[midHeader + 1]!.indexOf('╭')
  const mx = boxRows(midBoot, midLeft)
  check('the box is five rows under the header', mx.top === midHeader + 1 && mx.bottom === midHeader + 5, `top ${mx.top} bottom ${mx.bottom}`)
  check('no row reads ⊞ SESSIONS', rowWith(midBoot, '⊞ SESSIONS') === -1)
  let midSprite = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(midBoot[mx.top + 1 + r]![midLeft + 3 + col]!, band.grid[r]![2 + col]!)) midSprite++
  check('the sprite cells equal the band’s (27 cells)', midSprite === 0, `${midSprite} cells differ`)
  const mfx = boxRows(midFull, midLeft)
  check('/critter at 120×40 flips to the eleven-row box and the strip', mfx.bottom === midHeader + 11 && rowWith(midFull, '⊞ SESSIONS') >= 0, `bottom ${mfx.bottom} strip ${rowWith(midFull, '⊞ SESSIONS')}`)
  check('the strip’s bottom border row with full is the pane’s bottom border row with mini', stripBottom(midFull) === paneBottom(midBoot, midLeft - 1, text(midBoot)[mx.top]!.lastIndexOf('╮') + 1), `${stripBottom(midFull)} vs ${paneBottom(midBoot, midLeft - 1, text(midBoot)[mx.top]!.lastIndexOf('╮') + 1)}`)

  console.log('§7 a resize from wide to narrow and back keeps the one sprite')
  let tripDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripWide[3 + r]![34 + col]!, band.grid[r]![2 + col]!)) tripDiff++
  check('wide before the resize: the box carries the band’s sprite cells', tripDiff === 0, `${tripDiff} cells differ`)
  let narrowDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tripNarrow[r]![2 + col]!, band.grid[r]![2 + col]!)) narrowDiff++
  check('narrow: the 80×21 band paints the same sprite cells', narrowDiff === 0, `${narrowDiff} cells differ`)
  check('wide again: the frame is the boot frame cell for cell', cellDiff(tripBack, boot) === 0, `${cellDiff(tripBack, boot)} cells differ`)

  console.log('§8 a compact window of 26 rows or more paints the one sprite with mini, the shipped square with full')
  let tallDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tallBoot[r]![2 + col]!, band.grid[r]![2 + col]!)) tallDiff++
  check('80×30 with mini: the band’s rows 0–2 carry the 80×21 sprite cells (27 cells)', tallDiff === 0, `${tallDiff} cells differ`)
  check('80×30 with mini: no half-block art below the three sprite rows', !tallBoot.slice(3, 7).some(row => row.slice(0, 16).some(cell => cell.c === '▀' || cell.c === '▄')))
  check('80×30 with full: the shipped square art, its air row on top and five rows of half-blocks under it', tallFull[0]!.slice(0, 16).every(cell => cell.c === ' ') && tallFull.slice(1, 6).every(row => row.slice(1, 14).some(cell => cell.c === '▀' || cell.c === '▄')))
  let tallFullDiff = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(tallFull[r]![2 + col]!, band.grid[r]![2 + col]!)) tallFullDiff++
  check('80×30 with full: the square is not the dock sprite', tallFullDiff > 0)

  console.log('§9 the 80×21 band is untouched')
  check('the 80×21 band paints the dock sprite at rows 0–2, columns 2–10', band.grid.slice(0, 3).every(row => row.slice(2, 11).every(cell => cell.c === '▀')))
  check('the band’s status row reads 1 session on', rowWith(band.grid, '1 session on') === 20, `row ${rowWith(band.grid, '1 session on')}`)

  console.log('§10 the title reads ✶ VIEW, and a click on it flips the critter between small and full and saves the choice')
  const clickBoot = clicked.marks['boot']!
  const clickFull = clicked.marks['click-full']!
  const clickMini = clicked.marks['click-mini']!
  check('every frame of the drive reads ✶ VIEW on row 1 and none reads ✶ SESSION', [boot, full, midBoot, clickBoot, clickFull, clickMini].every(g => rowWith(g, '✶ VIEW') >= 0 && rowWith(g, '✶ SESSION') === -1) && rowWith(clickBoot, '✶ VIEW') === 1, `row ${rowWith(clickBoot, '✶ VIEW')}`)
  check('a click on VIEW flips the box to the eleven-row full form (border at 2, border at 12) with the crown row', boxRows(clickFull, 31).top === 2 && boxRows(clickFull, 31).bottom === 12 && text(clickFull)[5]!.includes('▄▄▀▀▀▀▀▀▄▄'), `top ${boxRows(clickFull, 31).top} bottom ${boxRows(clickFull, 31).bottom}`)
  check('with full, the SESSIONS bar is back at row 42', rowWith(clickFull, '⊞ SESSIONS') === 42, `row ${rowWith(clickFull, '⊞ SESSIONS')}`)
  check('a second click flips back to the slim five-row box (border at 2, border at 6) and the bar is gone', boxRows(clickMini, 31).top === 2 && boxRows(clickMini, 31).bottom === 6 && rowWith(clickMini, '⊞ SESSIONS') === -1, `top ${boxRows(clickMini, 31).top} bottom ${boxRows(clickMini, 31).bottom}`)
  let clickSprite = 0
  for (let r = 0; r < 3; r++) for (let col = 0; col < 9; col++) if (!sameCell(clickMini[3 + r]![34 + col]!, band.grid[r]![2 + col]!)) clickSprite++
  check('the slim box carries the band’s sprite cells again (27 cells)', clickSprite === 0, `${clickSprite} cells differ`)
  const savedSize = (JSON.parse(readFileSync(join(clickWorld.configHome, 'settings.json'), 'utf8')) as { critterSize?: string }).critterSize
  check('the click saved the size to the settings store (critterSize mini after the second click)', savedSize === 'mini', `critterSize ${String(savedSize)}`)
} catch (error) {
  failures++
  console.log(`  [FAIL] drive — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (failures === 0) rmSync(scratch, { recursive: true, force: true })
  else console.log(`  scratch kept for reading: ${scratch}`)
}

console.log(failures === 0 ? '\ncritter mini drive: GREEN' : `\ncritter mini drive: ${failures} RED`)
process.exit(failures === 0 ? 0 : 1)
