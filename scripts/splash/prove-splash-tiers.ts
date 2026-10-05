#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const PROBE = join(import.meta.dir, 'screen-probe.mjs')
const RENDER = join(import.meta.dir, 'render-final-screen.py')
const FIXTURE = join(import.meta.dir, 'fixtures', 'final-screens-0d08117e8.json')
const PY = '/usr/bin/python3'
const GEOMETRIES: ReadonlyArray<readonly [number, number]> = [[80, 24], [100, 34], [120, 40], [120, 44], [160, 50]]
const TIERS = ['truecolor', '256', 'nocolor'] as const
const MODES = ['oneshot', 'cinematic'] as const
type Tier = (typeof TIERS)[number]
type Mode = (typeof MODES)[number]
type Screen = { cols: number; rows: number; text: string[]; styles: string[]; palette: string[] }
type Cell = { ch: string; fg: string; bg: string; bold: boolean; reverse: boolean }
type Fixture = { recordedFrom: string; probe: string; renderer: string; screens: Record<string, Screen> }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const keyOf = (cols: number, rows: number, tier: Tier, mode: Mode): string => `${mode}/${tier}/${cols}x${rows}`

const ALPHABET = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"

export function cellAt(screen: Screen, x: number, y: number): Cell {
  const ch = [...(screen.text[y] ?? '')][x] ?? ' '
  const code = (screen.styles[y] ?? '')[x] ?? ALPHABET[0]!
  const entry = screen.palette[ALPHABET.indexOf(code)] ?? 'default|default|0|0'
  const [fg, bg, bold, reverse] = entry.split('|')
  return { ch, fg: fg!, bg: bg!, bold: bold === '1', reverse: reverse === '1' }
}
const sameCell = (a: Cell, b: Cell): boolean => a.ch === b.ch && a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.reverse === b.reverse
const lowerHalfOf = (base: Cell, now: Cell): boolean =>
  base.ch === '▀' && base.bg !== 'default' && now.ch === '▄' && now.fg === base.bg && now.bg === base.fg && now.bold === base.bold && now.reverse === base.reverse

export function twoColourCells(base: Screen): number {
  let n = 0
  for (let y = 0; y < base.rows; y++) for (let x = 0; x < base.cols; x++) {
    const cell = cellAt(base, x, y)
    if (cell.ch === '▀' && cell.bg !== 'default') n++
  }
  return n
}

export function compareToRecord(base: Screen, now: Screen): { equal: boolean; lowerHalf: number; detail: string } {
  if (base.cols !== now.cols || base.rows !== now.rows) return { equal: false, lowerHalf: 0, detail: `geometry ${base.cols}x${base.rows} vs ${now.cols}x${now.rows}` }
  let lowerHalf = 0
  const diffs: string[] = []
  for (let y = 0; y < base.rows; y++) {
    for (let x = 0; x < base.cols; x++) {
      const a = cellAt(base, x, y)
      const b = cellAt(now, x, y)
      if (sameCell(a, b)) continue
      if (lowerHalfOf(a, b)) {
        lowerHalf++
        continue
      }
      diffs.push(`${x},${y}: ${JSON.stringify(a.ch)} ${a.fg}/${a.bg} → ${JSON.stringify(b.ch)} ${b.fg}/${b.bg}`)
    }
  }
  return { equal: diffs.length === 0, lowerHalf, detail: diffs.length === 0 ? `${lowerHalf} lower-half cells` : `${diffs.length} cells differ beyond the lower-half rule: ${diffs.slice(0, 6).join('; ')}` }
}

export function compareGlyphsAcrossTiers(truecolor: Screen, other: Screen): { equal: boolean; lowerHalf: number; detail: string } {
  if (truecolor.cols !== other.cols || truecolor.rows !== other.rows) return { equal: false, lowerHalf: 0, detail: 'geometry differs' }
  let lowerHalf = 0
  const diffs: string[] = []
  for (let y = 0; y < truecolor.rows; y++) {
    for (let x = 0; x < truecolor.cols; x++) {
      const a = cellAt(truecolor, x, y)
      const b = cellAt(other, x, y)
      if (a.ch === b.ch) continue
      if (a.ch === '▄' && a.bg !== 'default' && b.ch === '▀') {
        lowerHalf++
        continue
      }
      diffs.push(`${x},${y}: ${JSON.stringify(a.ch)} vs ${JSON.stringify(b.ch)}`)
    }
  }
  return { equal: diffs.length === 0, lowerHalf, detail: diffs.length === 0 ? `${lowerHalf} lower-half cells` : `${diffs.length} glyphs differ beyond the lower-half rule: ${diffs.slice(0, 6).join('; ')}` }
}

function tierEnv(tier: Tier): Record<string, string> {
  if (tier === 'truecolor') return { COLORTERM: 'truecolor' }
  if (tier === '256') return { MERCURY_TRUECOLOR: '0' }
  return { NO_COLOR: '1' }
}

function capture(splashDir: string, cols: number, rows: number, tier: Tier, mode: Mode): { raw: Buffer; screen: Screen } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'splash-tiers-home-')))
  const tee = join(home, 'tee.raw')
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TERM: 'xterm-256color',
      MERCURY_HOME: home,
      MERCURY_CONFIG_DIR: home,
      MERCURY_CREDENTIAL_STORE: 'file',
      MERCURY_LOCAL_PROBE_TARGETS: 'none',
      ...tierEnv(tier),
      ...(mode === 'oneshot' ? { MERCURY_SPLASH_ONESHOT: '1' } : {}),
    }
    const run = spawnSync('node', [PROBE, join(splashDir, 'mercury-splash.mjs'), String(cols), String(rows), tee], { env, encoding: 'utf8', timeout: 30_000 })
    if (run.status !== 0) throw new Error(`screen-probe ${mode}/${tier}/${cols}x${rows} exited ${run.status}: ${run.stderr.slice(-400)}`)
    const raw = readFileSync(tee)
    const render = spawnSync(PY, [RENDER, tee, String(cols), String(rows)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
    if (render.status !== 0) throw new Error(`render-final-screen ${mode}/${tier}/${cols}x${rows} exited ${render.status}: ${render.stderr.slice(-400)}`)
    return { raw, screen: JSON.parse(render.stdout) as Screen }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

const recordAt = process.argv.indexOf('--record')
if (recordAt >= 0) {
  const splashDir = resolve(process.argv[recordAt + 1] ?? '')
  if (!existsSync(join(splashDir, 'mercury-splash.mjs'))) throw new Error('--record needs the base tree\'s assets/splash directory')
  if (existsSync(FIXTURE)) throw new Error(`the record is write-once: ${FIXTURE}`)
  const sha = spawnSync('git', ['-C', splashDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const screens: Record<string, Screen> = {}
  for (const [cols, rows] of GEOMETRIES) for (const mode of MODES) for (const tier of TIERS) screens[keyOf(cols, rows, tier, mode)] = capture(splashDir, cols, rows, tier, mode).screen
  mkdirSync(join(import.meta.dir, 'fixtures'), { recursive: true })
  const fixture: Fixture = { recordedFrom: sha, probe: 'scripts/splash/screen-probe.mjs', renderer: 'scripts/splash/render-final-screen.py', screens }
  writeFileSync(FIXTURE, JSON.stringify(fixture) + '\n', { flag: 'wx' })
  console.log(`recorded ${Object.keys(screens).length} final screens from ${sha} into ${FIXTURE}`)
  process.exit(0)
}

console.log('============================================================')
console.log(' splash — the final screen across tiers and against the .27 base, oneshot and cinematic')
console.log('============================================================')

section('§1 the comparators\' teeth (synthetic screens)')
{
  const S = (text: string[], styles: string[], palette: string[]): Screen => ({ cols: text[0]!.length, rows: text.length, text, styles, palette })
  const P = ['default|default|0|0', 'ff0000|0000ff|0|0', '0000ff|ff0000|0|0', 'ff0000|default|0|0', 'default|ff0000|0|0']
  const base = S(['▀▀x ', ' ▀  '], ['#%!!', '!%!!'], P)
  const swapped = S(['▄▀x ', ' ▀  '], ['$%!!', '!%!!'], P)
  check('a ▀ cell with a background becoming ▄ with the colours swapped is the lower-half rule, counted', compareToRecord(base, swapped).equal && compareToRecord(base, swapped).lowerHalf === 1)
  const unswapped = S(['▄▀x ', ' ▀  '], ['#%!!', '!%!!'], P)
  check('…the same glyph change without the swap is refused', !compareToRecord(base, unswapped).equal, compareToRecord(base, unswapped).detail)
  const topOnly = S(['▀▄x ', ' ▀  '], ['#%!!', '!%!!'], P)
  check('a top-only ▀ (no background) becoming ▄ is refused', !compareToRecord(base, topOnly).equal, compareToRecord(base, topOnly).detail)
  const trail = S(['▀▀x ', ' ▀ ·'], ['#%!!', '!%!%'], P)
  check('a trail glyph left on a blank cell is refused', !compareToRecord(base, trail).equal, compareToRecord(base, trail).detail)
  const recoloured = S(['▀▀x ', ' ▀  '], ['#%!!', '!&!!'], P)
  check('a colour-only change is refused against the record', !compareToRecord(base, recoloured).equal)
  check('…and allowed across tiers (colour-only across tiers)', compareGlyphsAcrossTiers(base, recoloured).equal && compareGlyphsAcrossTiers(base, recoloured).lowerHalf === 0)
  const plainTier = S(['▀▀x ', ' ▀  '], ['!!!!', '!!!!'], P)
  check('across tiers: a truecolor ▄ with a background against the plain tier\'s ▀ is the lower-half rule, counted', compareGlyphsAcrossTiers(swapped, plainTier).equal && compareGlyphsAcrossTiers(swapped, plainTier).lowerHalf === 1)
  const plainTrail = S(['▀▀x ', ' ▀ ·'], ['!!!!', '!!!!'], P)
  check('across tiers: any other glyph difference is refused', !compareGlyphsAcrossTiers(swapped, plainTrail).equal)
}

if (!existsSync(FIXTURE)) {
  check('the .27 base record exists (bun scripts/splash/prove-splash-tiers.ts --record <base>/assets/splash)', false, FIXTURE)
  console.log(`\n❌ splash tiers RED — ${failures} failure(s)`)
  process.exit(1)
}
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture
check(`the record was taken from the .27 base (${fixture.recordedFrom.slice(0, 9)}) with this probe and renderer`, fixture.recordedFrom.startsWith('0d08117e8') && fixture.probe === 'scripts/splash/screen-probe.mjs' && fixture.renderer === 'scripts/splash/render-final-screen.py')

const now = new Map<string, { raw: Buffer; screen: Screen }>()
const dirAt = process.argv.indexOf('--splash-dir')
const splashDir = dirAt >= 0 ? resolve(process.argv[dirAt + 1] ?? '') : join(ROOT, 'assets', 'splash')
console.log(`splash under proof: ${splashDir}`)
for (const [cols, rows] of GEOMETRIES) for (const mode of MODES) for (const tier of TIERS) now.set(keyOf(cols, rows, tier, mode), capture(splashDir, cols, rows, tier, mode))

for (const mode of MODES) {
  section(mode === 'oneshot' ? '§2 the painted frame (oneshot) against the .27 base\'s recorded screen' : '§3 the cinematic run\'s final screen (the trace, the fade and the hold) against the .27 base\'s recorded screen')
  for (const [cols, rows] of GEOMETRIES) {
    for (const tier of TIERS) {
      const key = keyOf(cols, rows, tier, mode)
      const base = fixture.screens[key]
      check(`${key}: recorded`, base !== undefined)
      if (base === undefined) continue
      const verdict = compareToRecord(base, now.get(key)!.screen)
      check(`${key}: every cell equal to the .27 base, the two-colour cells' lower half excepted (${verdict.lowerHalf} such cells)`, verdict.equal, verdict.detail)
      const pairs = twoColourCells(base)
      if (tier === 'truecolor') check(`${key}: every two-colour cell of the .27 base (${pairs}) is a lower-half cell now, and only those`, verdict.lowerHalf === pairs, `${verdict.lowerHalf} of ${pairs}`)
      else check(`${key}: no lower-half cell outside truecolor (the rule is truecolor's)`, verdict.lowerHalf === 0, `${verdict.lowerHalf}`)
    }
  }
}

section('§4 across tiers on this tree: colour-only, the two-colour cells\' lower half excepted')
for (const [cols, rows] of GEOMETRIES) {
  for (const mode of MODES) {
    const tc = now.get(keyOf(cols, rows, 'truecolor', mode))!
    for (const tier of ['256', 'nocolor'] as const) {
      const other = now.get(keyOf(cols, rows, tier, mode))!
      const verdict = compareGlyphsAcrossTiers(tc.screen, other.screen)
      check(`${mode} ${cols}x${rows}: ${tier} paints the same glyphs as truecolor, the lower half excepted (${verdict.lowerHalf} cells)`, verdict.equal, verdict.detail)
    }
    const plain = now.get(keyOf(cols, rows, 'nocolor', mode))!
    check(`${mode} ${cols}x${rows}: NO_COLOR carries no colour on screen`, plain.screen.palette.every(p => p.startsWith('default|default|')), plain.screen.palette.join(' '))
    const plainSgrs = plain.raw.toString('latin1').match(/\x1b\[[0-9;]*m/g) ?? []
    if (mode === 'oneshot') check(`${mode} ${cols}x${rows}: NO_COLOR puts no SGR on the wire`, plainSgrs.length === 0, plainSgrs.slice(0, 4).join(' '))
    else check(`${mode} ${cols}x${rows}: NO_COLOR puts no SGR on the wire but the hold's park ink`, plainSgrs.every(sgr => sgr === '\x1b[30;40m' || sgr === '\x1b[8m'), [...new Set(plainSgrs)].slice(0, 6).join(' '))
    const r256 = now.get(keyOf(cols, rows, '256', mode))!.raw.toString('latin1')
    check(`${mode} ${cols}x${rows}: the 256 tier carries no 24-bit colour on the wire`, !r256.includes('[38;2;') && !r256.includes('[48;2;') && r256.includes('[38;5;'))
    check(`${mode} ${cols}x${rows}: truecolor carries 24-bit colour on the wire`, tc.raw.toString('latin1').includes('[38;2;'))
  }
}

section('§5 the cinematic run ran its trace in truecolor only, and the screen is deterministic')
for (const [cols, rows] of GEOMETRIES) {
  const brackets = (tier: Tier): number => now.get(keyOf(cols, rows, tier, 'cinematic'))!.raw.toString('latin1').split('\x1b[?2026h').length - 1
  check(`${cols}x${rows}: the truecolor run painted the trace (${brackets('truecolor')} synchronised frames; the other tiers collapse straight to the hold: ${brackets('256')} / ${brackets('nocolor')})`, brackets('truecolor') >= 20 && brackets('256') <= 2 && brackets('nocolor') <= 2)
}
{
  const again = capture(splashDir, 120, 44, 'truecolor', 'cinematic')
  const verdict = compareToRecord(now.get(keyOf(120, 44, 'truecolor', 'cinematic'))!.screen, again.screen)
  check('a second cinematic run at 120x44 ends on the same screen, cell for cell', verdict.equal && verdict.lowerHalf === 0, verdict.detail)
}

console.log(`\n${failures === 0 ? '✅ splash tiers GREEN' : `❌ splash tiers RED — ${failures} failure(s)`}`)
process.exit(failures === 0 ? 0 : 1)
