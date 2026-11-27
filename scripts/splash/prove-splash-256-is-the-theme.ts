#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEADSTD, WORD } from '../../assets/splash/splash-core.mjs'
import { rgbToXterm256, xterm256ToRgb } from '../../src/screen/renderer/cell-grid.ts'
import { FAINT } from '../../src/screen/theme/mercuryPalette.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const PROBE = join(HERE, 'screen-probe.mjs')
const RENDER = join(HERE, 'render-final-screen.py')
const PY = '/usr/bin/python3'
const COLS = 120
const ROWS = 44
const FAMILIES = ['crab', 'octopus', 'jellyfish', 'clam'] as const

type Screen = { cols: number; rows: number; text: string[]; styles: string[]; palette: string[] }
type Cell = { ch: string; fg: string; bg: string; bold: boolean; reverse: boolean }

const ALPHABET = "!#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_`abcdefghijklmnopqrstuvwxyz{|}~"

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

function isGreyHex(hex: string): boolean {
  return /^[0-9a-f]{6}$/.test(hex) && hex.slice(0, 2) === hex.slice(2, 4) && hex.slice(2, 4) === hex.slice(4, 6)
}

function hexOfRgb(rgb: readonly [number, number, number]): string {
  return rgb.map(v => v.toString(16).padStart(2, '0')).join('')
}

function parseHex(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]
}

function capture(family: string, tier: 'truecolor' | '256'): { raw: string; screen: Screen } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'splash-256-theme-')))
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
      MERCURY_CRITTER: family,
      MERCURY_FULLSCREEN: '0',
      MERCURY_SPLASH_ONESHOT: '1',
      ...(tier === 'truecolor' ? { COLORTERM: 'truecolor' } : { MERCURY_TRUECOLOR: '0' }),
    }
    const run = spawnSync('node', [PROBE, SPLASH, String(COLS), String(ROWS), tee], { env, encoding: 'utf8', timeout: 30_000 })
    if (run.status !== 0) throw new Error(`screen-probe ${family}/${tier} exited ${run.status}: ${run.stderr.slice(-400)}`)
    const raw = readFileSync(tee, 'latin1')
    const render = spawnSync(PY, [RENDER, tee, String(COLS), String(ROWS)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 })
    if (render.status !== 0) throw new Error(`render-final-screen ${family}/${tier} exited ${render.status}: ${render.stderr.slice(-400)}`)
    return { raw, screen: JSON.parse(render.stdout) as Screen }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function colorSgrs(raw: string): { all256: boolean; bad: string[]; count256: number } {
  const bad: string[] = []
  let count256 = 0
  for (const m of raw.matchAll(/\x1b\[([0-9;]*)m/g)) {
    const body = m[1] ?? ''
    if (body === '' || body === '0') continue
    const nums = body.split(';').map(Number)
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i]!
      if (n === 0 || n === 1 || n === 2 || n === 4 || n === 7 || n === 8 || n === 22 || n === 24 || n === 27 || n === 39 || n === 49) continue
      if ((n === 38 || n === 48) && nums[i + 1] === 5 && i + 2 < nums.length) {
        count256++
        i += 2
        continue
      }
      if ((n === 38 || n === 48) && nums[i + 1] === 2) {
        bad.push(`\x1b[${body}m`)
        i += 4
        continue
      }
      bad.push(`\x1b[${body}m`)
    }
  }
  return { all256: bad.length === 0 && count256 > 0, bad, count256 }
}

const HEAD_W = Math.max(...HEADSTD.map(r => r.length))
const HEAD_ROWS = HEADSTD.map(r => r.padEnd(HEAD_W, '.'))
const HEAD_ACCENT_CELLS: Array<{ dx: number; dy: number; twoTone: boolean }> = []
for (let y = 0; y < HEAD_ROWS.length; y += 2) {
  for (let x = 0; x < HEAD_W; x++) {
    const t = HEAD_ROWS[y]![x]!
    const b = y + 1 < HEAD_ROWS.length ? HEAD_ROWS[y + 1]![x]! : '.'
    const tAcc = t === 'R' || t === 'r'
    const bAcc = b === 'R' || b === 'r'
    if (tAcc || bAcc) {
      HEAD_ACCENT_CELLS.push({ dx: x, dy: y / 2, twoTone: t !== '.' && b !== '.' && t !== b })
    }
  }
}

function findHeadOrigin(screen: Screen): { x0: number; y0: number } | null {
  let firstRow = ''
  for (let x = 0; x < HEAD_W; x++) {
    const t = HEAD_ROWS[0]![x]!
    const b = HEAD_ROWS[1]![x]!
    firstRow += t === '.' && b === '.' ? ' ' : t !== '.' && b === '.' ? '▀' : t === '.' && b !== '.' ? '▄' : t === b ? '█' : '▄'
  }
  const trimmed = firstRow.trim()
  const leadSpaces = firstRow.length - firstRow.trimStart().length
  for (let y = 0; y < screen.rows; y++) {
    const idx = screen.text[y]!.indexOf(trimmed)
    if (idx >= 0) return { x0: idx - leadSpaces, y0: y }
  }
  return null
}

function findWordRow(screen: Screen): number {
  let firstRow = ''
  const w = Math.max(...WORD.map(r => r.length))
  const g = WORD.map(r => r.padEnd(w, '.'))
  for (let x = 0; x < w; x++) {
    const t = g[0]![x]!
    const b = g[1]![x]!
    firstRow += t === '.' && b === '.' ? ' ' : t !== '.' && b === '.' ? '▀' : t === '.' && b !== '.' ? '▄' : '█'
  }
  const needle = firstRow.trim()
  for (let y = 0; y < screen.rows; y++) {
    if (screen.text[y]!.includes(needle)) return y
  }
  return -1
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
console.log(' splash — 256 tier is the theme through rgbToXterm256 (four families)')
console.log('============================================================')

const [fr, fg, fb] = parseHex(FAINT)
const faint256 = rgbToXterm256(fr, fg, fb)
const faintHex = hexOfRgb(xterm256ToRgb(faint256) ?? [0, 0, 0])

for (const family of FAMILIES) {
  section(`family: ${family}`)
  const tc = capture(family, 'truecolor')
  const s256 = capture(family, '256')

  const mutedCells = findTextCells(s256.screen, 'Model')
  const mutedFgs = [...new Set(mutedCells.map(c => c.fg))]
  check(
    `${family} (a): muted ink is a grey matching rgbToXterm256(FAINT) (${faint256} #${faintHex})`,
    mutedCells.length > 0 && mutedFgs.every(isGreyHex) && mutedFgs.every(h => h === faintHex),
    `got ${mutedFgs.join(',')} (wanted #${faintHex})`,
  )

  const wordY = findWordRow(s256.screen)
  const wordInks = new Set<string>()
  if (wordY >= 0) {
    for (let x = 0; x < s256.screen.cols; x++) {
      const c = cellAt(s256.screen, x, wordY)
      if (c.ch !== ' ' && c.fg !== 'default') wordInks.add(c.fg)
    }
  }
  check(
    `${family} (b): wordmark row holds at least 3 distinct inks`,
    wordY >= 0 && wordInks.size >= 3,
    `row=${wordY} inks=${wordInks.size} (${[...wordInks].join(',')})`,
  )

  const headOrigin = findHeadOrigin(tc.screen)
  const critterInks = new Set<string>()
  let greyAccentCells = 0
  let twoToneWithBg = 0
  let twoToneTotal = 0
  if (headOrigin !== null) {
    for (const pos of HEAD_ACCENT_CELLS) {
      const c = cellAt(s256.screen, headOrigin.x0 + pos.dx, headOrigin.y0 + pos.dy)
      if (c.fg !== 'default') {
        critterInks.add(c.fg)
        if (isGreyHex(c.fg)) greyAccentCells++
      }
      if (pos.twoTone) {
        twoToneTotal++
        if (c.bg !== 'default') twoToneWithBg++
      }
    }
  }
  check(
    `${family} (c): critter accent holds at least 2 distinct inks and no accent cell is grey`,
    headOrigin !== null && critterInks.size >= 2 && greyAccentCells === 0,
    `inks=${critterInks.size} (${[...critterInks].join(',')}) grey=${greyAccentCells}`,
  )
  check(
    `${family} (c2): two-tone critter cells carry both fg and bg at 256`,
    twoToneTotal > 0 && twoToneWithBg === twoToneTotal,
    `${twoToneWithBg}/${twoToneTotal} two-tone cells carry bg`,
  )

  const wire = colorSgrs(s256.raw)
  check(
    `${family} (d): every colour code on the screen is a 256 code`,
    wire.all256,
    wire.bad.length > 0 ? `non-256 SGRs: ${wire.bad.slice(0, 6).join(' ')}` : `count256=${wire.count256}`,
  )

  const glyphDiffs: string[] = []
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const a = cellAt(tc.screen, x, y)
      const b = cellAt(s256.screen, x, y)
      if (a.ch !== b.ch) glyphDiffs.push(`${x},${y}:${JSON.stringify(a.ch)}!=${JSON.stringify(b.ch)}`)
    }
  }
  check(
    `${family} (e): every glyph equals the 24-bit tier in that cell`,
    glyphDiffs.length === 0,
    `${glyphDiffs.length} glyphs differ: ${glyphDiffs.slice(0, 6).join('; ')}`,
  )
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-splash-256-is-the-theme — ${passed}/${passed + failures} checks passed (${failures} failed)`)
process.exit(failures === 0 ? 0 : 1)
