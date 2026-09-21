#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { captureEngineEntry, resolveCaptureDriver, vshotBudgetMs } from '../lib/captureDriver.ts'
import { firstRunCardsCentred } from '../../src/components/MercurySetupFrame.tsx'

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist/mercury.mjs'))
const FRAMES = arg('--frames')
const SIZES = (arg('--sizes') ?? '178x51,120x40').split(',').map(size => size.split('x').map(Number) as [number, number])
const STATES = (arg('--states') ?? 'centred,top-left').split(',')
if (!existsSync(DIST)) {
  console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
  process.exit(1)
}
const driver = resolveCaptureDriver()
if (driver.kind === 'unavailable') throw new Error(driver.remedy)
const vendoredNode = join(dirname(DIST), 'vendor/node', process.platform === 'win32' ? 'node.exe' : join('bin', 'node'))
const node = existsSync(vendoredNode) ? vendoredNode : 'node'

const WORLD_ROOT = existsSync('/private/tmp/mw') ? '/private/tmp/mw' : realpathSync(tmpdir())
mkdirSync(WORLD_ROOT, { recursive: true })
const SCRATCH = realpathSync(mkdtempSync(join(WORLD_ROOT, 'first-run-cards-')))
const work = join(SCRATCH, 'work')
mkdirSync(work, { recursive: true })
writeFileSync(join(work, 'README.md'), '# first-run cards fixture\n')
if (FRAMES !== undefined) mkdirSync(FRAMES, { recursive: true })

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const DEAD = 'http://127.0.0.1:9'
function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_DAEMON_DIR: join(home, 'daemon'),
    MERCURY_TEAMS_DIR: join(home, 'teams'),
    MERCURY_TABULA_DIR: join(home, 'tabula'),
    MERCURY_HOME: join(home, 'proof-home'),
    MERCURY_DOCTOR_STATE_DIR: join(home, 'doctor-state'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_IDE_SKIP_AUTO_INSTALL: '1',
    MERCURY_LIVE_GLYPHS: '0',
    MERCURY_CRITTER_GAZE: '0',
    MERCURY_CRITTER_IDLE: '0',
    MERCURY_DECK_COMPANION: '0',
    MERCURY_UPDATE_NOTICE: '0',
    MERCURY_CRITTER: 'jellyfish',
    TERM_PROGRAM: 'vscode',
    BROWSER: '/usr/bin/true',
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
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    COLORTERM: 'truecolor',
  }
  for (const key of [
    'NODE_ENV', 'MERCURY_DEMO', 'MERCURY_FULLSCREEN', 'MERCURY_ALT_HELD', 'MERCURY_MODEL', 'MERCURY_THEME_PIN',
    'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'MERCURY_OAUTH_TOKEN', 'MERCURY_API_KEY_FILE_DESCRIPTOR', 'CLAUDE_CODE_OAUTH_TOKEN',
    'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MOONSHOT_API_KEY', 'DEEPSEEK_API_KEY', 'HF_TOKEN', 'MERCURY_MOONSHOT_OAUTH_CLIENT_ID',
    'CURSOR_TRACE_ID', 'VSCODE_GIT_ASKPASS_MAIN', '__CFBundleIdentifier', 'VisualStudioVersion', 'TERMINAL_EMULATOR',
  ]) {
    delete env[key]
  }
  return env
}

type Cell = { c: string; fg: string; bg: string; bold: boolean; rev: boolean }
type Grid = Cell[][]
type Send = Record<string, unknown>
type Box = { top: number; left: number; width: number; height: number }
const STATIONS = ['theme', 'provider', 'guardrails', 'terminal', 'trust'] as const
type Station = (typeof STATIONS)[number]
const AMBER_FG = 'dba13d'
const BROWN_FG = 'c8a882'

const WALK: Send[] = [
  { requireAwait: true, awaitText: 'Choose your theme', awaitSettleTicks: 4, awaitStableTicks: 3, mark: 'theme', data: '\r' },
  { requireAwait: true, awaitText: 'Sign in later', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'provider', data: '\x1b[B' },
  ...Array.from({ length: 8 }, (): Send => ({ afterPrevTicks: 2, data: '\x1b[B' })),
  { afterPrevTicks: 3, data: '\r' },
  { requireAwait: true, awaitText: 'Guardrails', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'guardrails', data: '\r' },
  { requireAwait: true, awaitText: 'Terminal keys', awaitSettleTicks: 3, awaitStableTicks: 3, mark: 'terminal', data: '\x1b[B' },
  { afterPrevTicks: 2, data: '\r' },
]

const gridText = (grid: Grid): string => grid.map(row => row.map(cell => cell.c || ' ').join('').trimEnd()).join('\n')

function cardBox(grid: Grid): Box | null {
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y]!
    for (let x = 0; x < row.length; x++) {
      if (row[x]!.c !== '╭') continue
      let right = x + 1
      while (right < row.length && row[right]!.c === '─') right++
      if (row[right]?.c !== '╮') return null
      let bottom = y + 1
      while (bottom < grid.length && grid[bottom]![x]!.c !== '╰') bottom++
      if (bottom >= grid.length) return null
      return { top: y, left: x, width: right - x + 1, height: bottom - y + 1 }
    }
  }
  return null
}

function outsideBlank(grid: Grid, box: Box): boolean {
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y]!.length; x++) {
      const inside = y >= box.top && y < box.top + box.height && x >= box.left && x < box.left + box.width
      if (!inside && grid[y]![x]!.c !== ' ') return false
    }
  }
  return true
}

function countFg(grid: Grid, fg: string): number {
  let n = 0
  for (const row of grid) for (const cell of row) if (cell.fg === fg && cell.c !== ' ') n++
  return n
}

function markCells(grid: Grid, glyph: string): Cell[] {
  const out: Cell[] = []
  for (const row of grid) for (const cell of row) if (cell.c === glyph) out.push(cell)
  return out
}

function sameCard(on: Grid, onBox: Box, off: Grid, offBox: Box): { same: boolean; mapped: number; first: string } {
  let mapped = 0
  for (let y = 0; y < offBox.height; y++) {
    for (let x = 0; x < offBox.width; x++) {
      const a = off[offBox.top + y]?.[offBox.left + x]
      const b = on[onBox.top + y]?.[onBox.left + x]
      if (!a || !b) return { same: false, mapped, first: `row ${y} col ${x} is off the grid` }
      const wantFg = a.fg === AMBER_FG ? BROWN_FG : a.fg
      if (a.fg === AMBER_FG) mapped++
      if (a.c !== b.c || wantFg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.rev !== b.rev) {
        return { same: false, mapped, first: `row ${y} col ${x}: shipped ${JSON.stringify(a)} vs ${JSON.stringify(b)}` }
      }
    }
  }
  return { same: true, mapped, first: '' }
}

async function walk(state: string, cols: number, rows: number): Promise<Record<Station, Grid> | null> {
  const tag = `${state}-${cols}x${rows}`
  const home = join(SCRATCH, `home-${tag}`)
  mkdirSync(home, { recursive: true })
  if (state !== 'centred') writeFileSync(join(home, 'settings.json'), `${JSON.stringify({ firstRunCards: state })}\n`)
  const dir = join(SCRATCH, `capture-${tag}`)
  mkdirSync(dir, { recursive: true })
  const cfgPath = join(dir, 'cfg.json')
  const outPath = join(dir, 'grid.json')
  writeFileSync(cfgPath, JSON.stringify({ argv: [node, DIST], cwd: work, cols, rows, total: 400, sends: WALK, readyText: ['trust · 5/5'], readySettleTicks: 3, stableTicks: 4, out: outPath }))
  const refusal = await new Promise<string | null>((resolveRun, rejectRun) => {
    execFile(driver.python, [captureEngineEntry(driver, ROOT), cfgPath], { env: childEnv(home), cwd: work, timeout: vshotBudgetMs(200_000), maxBuffer: 1 << 26 }, (error, _stdout, stderr) => {
      if (error && !existsSync(outPath)) rejectRun(new Error(`${String(error)}\n${stderr}`))
      else resolveRun(error ? String(stderr).split('\n').find(line => line.includes('[vshot]')) ?? String(error) : null)
    })
  })
  if (refusal !== null) {
    check(`${tag}: the walk reached every station`, false, refusal.slice(0, 200))
    return null
  }
  const payload = JSON.parse(readFileSync(outPath, 'utf8')) as { grid: Grid; marks?: Array<{ label: string; grid: Grid }> }
  const grids: Partial<Record<Station, Grid>> = { trust: payload.grid }
  for (const m of payload.marks ?? []) grids[m.label as Station] = m.grid
  const missing = STATIONS.filter(s => grids[s] === undefined)
  check(`${tag}: the walk reached every station`, missing.length === 0, `missing ${missing.join(',')}`)
  if (missing.length > 0) return null
  if (FRAMES !== undefined) {
    for (const station of STATIONS) {
      writeFileSync(join(FRAMES, `${tag}-${station}.txt`), `${gridText(grids[station]!)}\n`)
      writeFileSync(join(FRAMES, `${tag}-${station}.json`), JSON.stringify({ cols, rows, grid: grids[station] }))
    }
  }
  return grids as Record<Station, Grid>
}

console.log('the five first-run cards sit centred on the screen, the trust tone in light brown; firstRunCards: top-left restores the shipped top-left amber cards — the built product in a PTY')
console.log(`  bundle ${DIST}\n  scratch ${SCRATCH}`)

console.log('\n── the setting')
check('an absent key reads as centred', firstRunCardsCentred(undefined) && firstRunCardsCentred({}))
check('centred reads as centred', firstRunCardsCentred({ firstRunCards: 'centred' }))
check('top-left reads as the shipped look', !firstRunCardsCentred({ firstRunCards: 'top-left' }))

try {
  for (const [cols, rows] of SIZES) {
    const size = `${cols}x${rows}`
    const shots: Partial<Record<string, Record<Station, Grid>>> = {}
    for (const state of STATES) {
      console.log(`\n── ${size} · firstRunCards ${state === 'centred' ? 'absent' : state}`)
      let grids: Record<Station, Grid> | null
      try {
        grids = await walk(state, cols, rows)
      } catch (err) {
        check(`${state}-${size}: the capture ran`, false, err instanceof Error ? err.message.slice(0, 400) : String(err))
        continue
      }
      if (grids === null) continue
      shots[state] = grids
      for (const station of STATIONS) {
        const grid = grids[station]
        const box = cardBox(grid)
        const label = `${state}-${size} ${station}`
        check(`${label}: one card box on the screen`, box !== null)
        if (box === null) continue
        const width = Math.max(Math.min(cols - 2, 100), 40)
        check(`${label}: the card keeps its width ${width}`, box.width === width, `width ${box.width}`)
        if (state === 'centred') {
          const left = Math.round((cols - box.width) / 2)
          const top = Math.floor((rows - box.height) / 2)
          check(`${label}: centred at row ${top}, column ${left}`, box.top === top && box.left === left, `card ${box.width}x${box.height} at row ${box.top}, column ${box.left}`)
          check(`${label}: no amber cell remains`, countFg(grid, AMBER_FG) === 0, `${countFg(grid, AMBER_FG)} amber cells`)
        } else {
          check(`${label}: top-left as shipped`, box.top === 0 && box.left === 0, `card ${box.width}x${box.height} at row ${box.top}, column ${box.left}`)
          check(`${label}: no brown cell`, countFg(grid, BROWN_FG) === 0, `${countFg(grid, BROWN_FG)} brown cells`)
        }
        check(`${label}: nothing painted outside the card`, outsideBlank(grid, box))
        if (station === 'guardrails') {
          const marks = markCells(grid, '▲')
          const want = state === 'centred' ? BROWN_FG : AMBER_FG
          check(`${label}: the two ▲ marks wear ${state === 'centred' ? 'light brown' : 'amber'}`, marks.length === 2 && marks.every(cell => cell.fg === want), marks.map(cell => cell.fg).join(','))
        }
        if (station === 'trust') {
          const want = state === 'centred' ? BROWN_FG : AMBER_FG
          const corner = grid[box.top]![box.left]!
          const inner = grid[box.top + 5]![box.left + 2]!
          const title = markCells(grid, '⦿')[0]
          check(`${label}: the frame border, the inner box and its title wear ${state === 'centred' ? 'light brown' : 'amber'}`, corner.fg === want && inner.c === '╭' && inner.fg === want && title !== undefined && title.fg === want, `corner ${corner.fg} inner ${inner.c}/${inner.fg} title ${title?.fg ?? 'absent'}`)
        }
        if (station === 'theme' || station === 'provider' || station === 'terminal') {
          check(`${label}: the accent border is untouched`, grid[box.top]![box.left]!.fg !== AMBER_FG && grid[box.top]![box.left]!.fg !== BROWN_FG, grid[box.top]![box.left]!.fg)
        }
      }
    }
    const on = shots.centred
    const off = shots['top-left']
    if (on && off) {
      console.log(`\n── ${size} · the centred card is the shipped card moved, amber to light brown`)
      for (const station of STATIONS) {
        const onBox = cardBox(on[station])
        const offBox = cardBox(off[station])
        if (onBox === null || offBox === null) continue
        const verdict = sameCard(on[station], onBox, off[station], offBox)
        check(`${size} ${station}: every cell inside the card is the shipped cell moved by (${onBox.top}, ${onBox.left})`, verdict.same && onBox.height === offBox.height, verdict.first)
        const wantMapped = station === 'guardrails' || station === 'trust'
        check(`${size} ${station}: ${wantMapped ? 'the amber cells took the brown' : 'no cell changed colour'}`, wantMapped ? verdict.mapped > 0 : verdict.mapped === 0, `${verdict.mapped} recoloured`)
      }
    }
  }
} finally {
  if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true })
  else console.log(`[forensics] world kept: ${SCRATCH}`)
}

console.log(`\n${failures === 0 ? 'prove-first-run-cards-drive: ALL LAWS HOLD' : `prove-first-run-cards-drive: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
