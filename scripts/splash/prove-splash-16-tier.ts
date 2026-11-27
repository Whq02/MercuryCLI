#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as splashCore from '../../assets/splash/splash-core.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const PROBE = join(HERE, 'screen-probe.mjs')
const RENDER = join(HERE, 'render-final-screen.py')
const FIXTURE = join(HERE, 'fixtures', 'final-screens.json')
const PY = '/usr/bin/python3'
const COLS = 120
const ROWS = 44

const BASIC_16_NAMES = new Set([
  'black', 'red', 'green', 'brown', 'blue', 'magenta', 'cyan', 'white',
  'brightblack', 'brightred', 'brightgreen', 'brightbrown', 'brightblue', 'brightmagenta', 'brightcyan', 'brightwhite',
])
const ALPHABET = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"

type Screen = { cols: number; rows: number; text: string[]; styles: string[]; palette: string[] }
type Cell = { ch: string; fg: string; bg: string; bold: boolean; reverse: boolean }

let failures = 0
let passed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) passed++
  else failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

function cellAt(screen: Screen, x: number, y: number): Cell {
  const ch = [...(screen.text[y] ?? '')][x] ?? ' '
  const code = (screen.styles[y] ?? '')[x] ?? ALPHABET[0]!
  const entry = screen.palette[ALPHABET.indexOf(code)] ?? 'default|default|0|0'
  const [fg, bg, bold, reverse] = entry.split('|')
  return { ch, fg: fg!, bg: bg!, bold: bold === '1', reverse: reverse === '1' }
}

function capture(extraEnv: Record<string, string | undefined>): { raw: string; screen: Screen } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'splash-16-tier-')))
  const tee = join(home, 'tee.raw')
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      MERCURY_HOME: home,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      MERCURY_FULLSCREEN: '0',
      MERCURY_SPLASH_ONESHOT: '1',
    }
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    const run = spawnSync('node', [PROBE, SPLASH, String(COLS), String(ROWS), tee], { env, encoding: 'utf8', timeout: 30_000 })
    if (run.status !== 0) throw new Error(`screen-probe exited ${run.status}: ${run.stderr.slice(-400)}`)
    const raw = readFileSync(tee, 'latin1')
    const render = spawnSync(PY, [RENDER, tee, String(COLS), String(ROWS)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
    if (render.status !== 0) throw new Error(`render-final-screen exited ${render.status}: ${render.stderr.slice(-400)}`)
    return { raw, screen: JSON.parse(render.stdout) as Screen }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function inspectBasicWire(raw: string): { basicCount: number; nonBasic: string[]; hasBg: boolean; has256: boolean; has24: boolean } {
  let basicCount = 0
  const nonBasic: string[] = []
  let hasBg = false
  let has256 = false
  let has24 = false
  for (const m of raw.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const body = m[1] ?? ''
    if (body === '' || body === '0') continue
    const nums = body.split(';').map(Number)
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!
      if (n === 0 || n === 1 || n === 2 || n === 4 || n === 7 || n === 8 || n === 22 || n === 24 || n === 27 || n === 39 || n === 49) continue
      if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        basicCount++
        continue
      }
      if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
        hasBg = true
        nonBasic.push(`\x1b[${body}m`)
        continue
      }
      if ((n === 38 || n === 48) && nums[i + 1] === 5) {
        has256 = true
        if (n === 48) hasBg = true
        nonBasic.push(`\x1b[${body}m`)
        i += 2
        continue
      }
      if ((n === 38 || n === 48) && nums[i + 1] === 2) {
        has24 = true
        if (n === 48) hasBg = true
        nonBasic.push(`\x1b[${body}m`)
        i += 4
        continue
      }
      nonBasic.push(`\x1b[${body}m`)
    }
  }
  return { basicCount, nonBasic, hasBg, has256, has24 }
}

function findTextCells(screen: Screen, needle: string): Cell[] {
  for (let y = 0; y < screen.rows; y++) {
    const idx = screen.text[y]!.indexOf(needle)
    if (idx < 0) continue
    const cells: Cell[] = []
    for (let k = 0; k < needle.length; k++) {
      const c = cellAt(screen, idx + k, y)
      if (c.ch !== ' ') cells.push(c)
    }
    return cells
  }
  return []
}

console.log('============================================================')
console.log(' splash — 16-colour tier, tier rule parity, win32 preservation')
console.log('============================================================')

section('§1 TERM=xterm and TERM=linux paint basic 16-colour codes only, muted ink is 90, glyphs equal plain')
const plainRef = capture({ TERM: 'xterm-256color', NO_COLOR: '1' })
for (const term of ['xterm', 'linux'] as const) {
  const cap = capture({ TERM: term })
  const wire = inspectBasicWire(cap.raw)
  check(
    `TERM=${term}: every colour code on the wire is basic (30-37, 90-97), no bg, no 256, no 24-bit`,
    wire.basicCount > 0 && wire.nonBasic.length === 0 && !wire.hasBg && !wire.has256 && !wire.has24,
    `basic=${wire.basicCount} has256=${wire.has256} has24=${wire.has24} hasBg=${wire.hasBg} sample=${wire.nonBasic.slice(0, 4).join(' ')}`,
  )
  const cellFgs = new Set<string>()
  let bgCells = 0
  let nonBasicCells = 0
  const glyphDiffs: string[] = []
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const c = cellAt(cap.screen, x, y)
      const p = cellAt(plainRef.screen, x, y)
      if (c.ch !== p.ch) glyphDiffs.push(`${x},${y}:${JSON.stringify(c.ch)}!=${JSON.stringify(p.ch)}`)
      if (c.bg !== 'default') bgCells++
      if (c.fg !== 'default') {
        cellFgs.add(c.fg)
        if (!BASIC_16_NAMES.has(c.fg)) nonBasicCells++
      }
    }
  }
  check(
    `TERM=${term}: every rendered cell carries basic 16 fg only and default bg`,
    cellFgs.size > 0 && nonBasicCells === 0 && bgCells === 0,
    `fgs=${[...cellFgs].slice(0, 6).join(',')} nonBasic=${nonBasicCells} bgCells=${bgCells}`,
  )
  check(
    `TERM=${term}: every glyph equals the plain tier in that cell (two-tone cells keep ▀)`,
    glyphDiffs.length === 0,
    `${glyphDiffs.length} glyphs differ: ${glyphDiffs.slice(0, 6).join('; ')}`,
  )
  const mutedCells = findTextCells(cap.screen, 'Model')
  const mutedFgs = [...new Set(mutedCells.map(c => c.fg))]
  check(
    `TERM=${term}: muted ink is SGR 90 (brightblack in cells)`,
    mutedCells.length > 0 && mutedFgs.length === 1 && mutedFgs[0] === 'brightblack',
    `got ${mutedFgs.join(',')}`,
  )
}
{
  const dumb = capture({ TERM: 'dumb' })
  const unset = capture({ TERM: undefined })
  check('TERM=dumb paints no colour codes (plain)', !/\x1b\[[0-9;]*m/.test(dumb.raw))
  check('TERM unset paints no colour codes (plain)', !/\x1b\[[0-9;]*m/.test(unset.raw))
}
section('§2 TERM=xterm-256color keeps the 256 tier; COLORTERM=truecolor keeps 24-bit byte for byte')
{
  const s256 = capture({ TERM: 'xterm-256color', MERCURY_TRUECOLOR: '0' })
  check(
    'TERM=xterm-256color: paints 256 codes and no 24-bit codes',
    s256.raw.includes('\x1b[38;5;') && !s256.raw.includes('\x1b[38;2;'),
  )
  const s256Auto = capture({ TERM: 'xterm-256color' })
  const diffs256: string[] = []
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const a = cellAt(s256.screen, x, y)
      const b = cellAt(s256Auto.screen, x, y)
      if (a.ch !== b.ch || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold) diffs256.push(`${x},${y}`)
    }
  }
  check(
    'TERM=xterm-256color without MERCURY_TRUECOLOR equals the explicit 256 tier cell for cell',
    diffs256.length === 0,
    `${diffs256.length} cells differ`,
  )

  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { screens: Record<string, Screen> }
  const rec = fixture.screens['oneshot/truecolor/120x44']!
  const tc = capture({ TERM: 'xterm-256color', COLORTERM: 'truecolor', MERCURY_CRITTER: 'jellyfish', MERCURY_FULLSCREEN: undefined })
  const tcDiffs: string[] = []
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const a = cellAt(rec, x, y)
      const b = cellAt(tc.screen, x, y)
      if (a.ch !== b.ch || a.fg !== b.fg || a.bg !== b.bg || a.bold !== b.bold || a.reverse !== b.reverse) {
        tcDiffs.push(`${x},${y}`)
      }
    }
  }
  check(
    'COLORTERM=truecolor matches the recorded 24-bit screen cell for cell',
    tc.raw.includes('\x1b[38;2;') && tcDiffs.length === 0,
    `${tcDiffs.length} cells differ`,
  )
}

section('§3 exported tier rule: 14-TERM matrix and win32 stand-in (no 16 on win32)')
{
  const exported = splashCore as Record<string, unknown>
  const tierFn = typeof exported.splashTierOf === 'function'
    ? (exported.splashTierOf as (env: Record<string, string | undefined>, platform?: string) => string)
    : null
  check('splash-core exports the single tier rule function (splashTierOf)', tierFn !== null, 'not exported yet')

  const MATRIX: ReadonlyArray<readonly [term: string | undefined, wantPosix: string]> = [
    ['xterm', '16'],
    ['xterm-color', '16'],
    ['linux', '16'],
    ['screen', '16'],
    ['vt100', '16'],
    ['rxvt', '16'],
    ['xterm-256color', '256'],
    ['screen-256color', '256'],
    ['tmux-256color', '256'],
    ['alacritty', '16'],
    ['foot', '16'],
    ['xterm-kitty', 'truecolor'],
    [undefined, 'plain'],
    ['dumb', 'plain'],
  ]
  for (const [term, want] of MATRIX) {
    const env: Record<string, string | undefined> = term === undefined ? {} : { TERM: term }
    const got = tierFn ? tierFn(env, 'linux') : 'missing'
    check(`posix TERM=${term ?? '<unset>'} -> ${want}`, got === want, `got=${got}`)
  }
  const win32Answers = MATRIX.map(([term]) => {
    const env: Record<string, string | undefined> = term === undefined ? {} : { TERM: term }
    return [term ?? '<unset>', tierFn ? tierFn(env, 'win32') : 'missing'] as const
  })
  check(
    'win32 stand-in: no environment answers 16',
    tierFn !== null && win32Answers.every(([, tier]) => tier !== '16' && tier !== 'missing'),
    win32Answers.map(([k, v]) => `${k}=${v}`).join(' '),
  )
}
console.log(`\n${failures === 0 ? '✅' : '❌'} prove-splash-16-tier — ${passed}/${passed + failures} checks passed (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
