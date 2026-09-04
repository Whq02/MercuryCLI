#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = mkdtempSync(join(tmpdir(), 'mercury-select-scroll-'))
void SCRATCH
const { runCompassArena, requireDist, grabScreens } = await import(`${ROOT}/scripts/navigation/arena.ts`)
const { TAIL_SENTINEL } = await import(`${ROOT}/scripts/navigation/fixture1k.ts`)

requireDist()
if (!process.env.NODE_BIN) {
  const bunWhich = (globalThis as { Bun?: { which?: (b: string) => string | null } }).Bun?.which?.('node') ?? null
  const shellWhich = spawnSync('which', ['node'], { encoding: 'utf8', env: process.env }).stdout?.trim() || null
  const found = [bunWhich, shellWhich, '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].filter((c): c is string => !!c).find(c => existsSync(c))
  if (!found) {
    console.error('no node found — set NODE_BIN')
    process.exit(2)
  }
  process.env.NODE_BIN = found
}

const COLS = 120
const ROWS = 40
const CHAPTERS = 8
const SETTLE = 9000
const PANE_C0 = 26
const PANE_C1 = 116

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const sgr = (b: number, col0: number, row0: number, release = false): string => `\\x1b[<${b};${col0 + 1};${row0 + 1}${release ? 'm' : 'M'}`
const LEFT = 0
const MOTION = 0x20
const WHEEL_UP = 64
const WHEEL_DOWN = 65
const PGUP = '\\x1b[5~'
const PGDN = '\\x1b[6~'

type AttrScreen = { atMs: number; rows: string[]; reverse: number[][]; bg: [number, number, string][] }
function attrGrab(drive: string, offsets: number[]): AttrScreen[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [`${ROOT}/scripts/render-continuity/lib/attrgrab.py`, drive, String(COLS), String(ROWS), ...offsets.map(String)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`attrgrab failed: ${res.stderr}`)
  return (JSON.parse(res.stdout) as { screens: AttrScreen[] }).screens
}

const silent = await runCompassArena({ sends: [], seconds: Math.ceil(SETTLE / 1000) + 3, chapters: CHAPTERS })
let anchor = { col: 34, row: 12 }
let tailRow = -1
let stripRow = ROWS - 4
let composerRow = ROWS - 3
let paneTop = 1
let screenRows: string[] = []
try {
  if (silent.outs.length === 0) {
    console.error('silent run produced no PTY output')
    process.exit(1)
  }
  const final = grabScreens(silent, COLS, ROWS, [-1]).find(s => s.atMs === -1)!
  screenRows = final.rows
  tailRow = final.rows.findIndex(r => r.includes(TAIL_SENTINEL))
  if (tailRow < 0) {
    console.error('the fixture tail is not on screen after the settle')
    console.error(final.rows.slice(-14).join('\n'))
    process.exit(1)
  }
  stripRow = final.rows.findIndex(r => r.includes('SESSIONS ›') || r.includes('SESSIONS'))
  composerRow = final.rows.findIndex(r => r.includes('Type a prompt'))
  if (stripRow < 0) stripRow = composerRow >= 0 ? composerRow : ROWS - 3
  for (let r = 1; r < tailRow; r++) if ((final.rows[r] ?? '')[25] === '╰') paneTop = r + 1
  let ar = Math.max(1, tailRow - 4)
  while (ar > 1 && (final.rows[ar] ?? '').slice(PANE_C0).trim().length < 12) ar--
  anchor = { col: PANE_C0 + 6, row: ar }
} finally {
  silent.cleanup()
}
const paneBottom = Math.max(1, stripRow - 1)
process.stderr.write(`[select-scroll] tail row ${tailRow}; anchor (${anchor.col},${anchor.row}); pane rows ${paneTop}..${paneBottom}; strip ${stripRow}; composer ${composerRow}\n`)

const t0 = SETTLE
const belowAnchor = { col: anchor.col + 24, row: Math.min(anchor.row + 2, paneBottom) }
const sends: string[] = [
  `${t0}:${sgr(LEFT, anchor.col, anchor.row)}`,
  `${t0 + 60}:${sgr(LEFT | MOTION, belowAnchor.col, belowAnchor.row)}`,
  `${t0 + 120}:${sgr(LEFT, belowAnchor.col, belowAnchor.row, true)}`,
  `${t0 + 700}:${sgr(WHEEL_UP, anchor.col, anchor.row)}`,
  `${t0 + 760}:${sgr(WHEEL_UP, anchor.col, anchor.row)}`,
  `${t0 + 820}:${sgr(WHEEL_UP, anchor.col, anchor.row)}`,
  `${t0 + 1500}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 1560}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 1620}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 2400}:${PGDN}`,
  `${t0 + 3100}:${PGUP}`,
]
const HOLD_MS = 200
const dragPress = { col: anchor.col, row: anchor.row }
const dragT = t0 + 3900
sends.push(`${dragT}:${sgr(LEFT, dragPress.col, dragPress.row)}`)
sends.push(`${dragT + 40}:${sgr(LEFT | MOTION, dragPress.col, 0)}`)
sends.push(`${dragT + 40 + HOLD_MS}:${sgr(LEFT, dragPress.col, 0, true)}`)

const lastMs = dragT + 40 + HOLD_MS
const seconds = Math.ceil((lastMs + 2500) / 1000)
const run = await runCompassArena({ sends, seconds, chapters: CHAPTERS })
try {
  if (run.outs.length === 0) {
    console.error(`no PTY output — ${run.driverOut.slice(-400)}`)
    process.exit(1)
  }
  const grabAt = [SETTLE + 400, SETTLE + 1100, SETTLE + 2000, SETTLE + 2700, SETTLE + 3400, lastMs + 200]
  const shots = attrGrab(run.paths.drive, grabAt)
  const [selA, wheelB, wheelC, pgdn, pgup, dragE] = shots

  const bgMapOf = (s: AttrScreen): Map<string, string> => new Map(s.bg.map(([x, y, c]) => [`${x},${y}`, c]))
  const paneBgFreq = (s: AttrScreen): string | null => {
    const f = new Map<string, number>()
    for (const [x, y, c] of s.bg) if (x >= PANE_C0 && x <= PANE_C1 && y >= 1 && y <= paneBottom) f.set(c, (f.get(c) ?? 0) + 1)
    let best = 0
    let color: string | null = null
    for (const [c, n] of f) if (n > best) { best = n; color = c }
    return color
  }
  const panelColor = selA ? paneBgFreq(selA) : null
  const sampleSelColor = (s: AttrScreen | undefined): string | null => {
    if (!s) return null
    const m = bgMapOf(s)
    for (let dy = 0; dy <= 2; dy++) for (let dx = 2; dx <= belowAnchor.col - anchor.col; dx++) {
      const c = m.get(`${anchor.col + dx},${anchor.row + dy}`)
      if (c && c !== panelColor) return c
    }
    return null
  }
  function highlightRows(s: AttrScreen | undefined, selColor: string | null): { rows: number[]; cells: [number, number][]; color: string | null } {
    if (!s || !selColor) return { rows: [], cells: [], color: selColor }
    const cells: [number, number][] = []
    const rowset = new Set<number>()
    for (const [x, y, c] of s.bg) if (c === selColor) { cells.push([x, y]); rowset.add(y) }
    return { rows: [...rowset].sort((a, b) => a - b), cells, color: selColor }
  }
  const textAt = (s: AttrScreen, cells: [number, number][]): string => {
    const byRow = new Map<number, number[]>()
    for (const [x, y] of cells) { (byRow.get(y) ?? byRow.set(y, []).get(y)!).push(x) }
    const rows = [...byRow.keys()].sort((a, b) => a - b)
    return rows.map(y => { const xs = byRow.get(y)!.sort((a, b) => a - b); return (s.rows[y] ?? '').slice(xs[0]!, xs[xs.length - 1]! + 1) }).join('\n').replace(/\s+$/g, '')
  }

  const selColor = sampleSelColor(selA)
  const a = highlightRows(selA, selColor)
  check('W0 a selection is highlighted on the transcript before scrolling', a.cells.length > 0 && selColor !== null, `${a.cells.length} cells; panel=${panelColor}; sel=${selColor}`)
  const selText = selA ? textAt(selA, a.cells) : ''
  const selUnique = selText.replace(/\s+/g, ' ').trim().slice(0, 24)
  process.stderr.write(`[select-scroll] selected text ≈ ${JSON.stringify(selUnique)} on rows ${a.rows.join(',')}\n`)

  const b = highlightRows(wheelB, selColor)
  check('W1 a wheel scroll under a selection keeps cells highlighted (does NOT clear)', b.cells.length > 0, `${b.cells.length} highlighted cells after wheel-up`)
  const bText = wheelB ? textAt(wheelB, b.cells).replace(/\s+/g, ' ').trim() : ''
  check('W1 the wheel-scrolled highlight still carries the selected text (it followed, no lag)', selUnique.length > 6 && bText.includes(selUnique.slice(0, Math.min(16, selUnique.length))), `after=${JSON.stringify(bText.slice(0, 40))} want≈${JSON.stringify(selUnique)}`)
  const bEscape = b.cells.filter(([x, y]) => x < PANE_C0 || x > PANE_C1 || y >= stripRow || y < paneTop)
  check('W2 the wheel-scrolled highlight paints no cell outside the transcript pane', bEscape.length === 0, `${bEscape.length} escaped, e.g. ${JSON.stringify(bEscape.slice(0, 4))}`)

  const c = highlightRows(wheelC, selColor)
  const cEscape = c.cells.filter(([x, y]) => x < PANE_C0 || x > PANE_C1 || y >= stripRow || y < paneTop)
  check('W2 the wheel-back highlight paints no cell outside the pane', cEscape.length === 0, `${cEscape.length} escaped`)

  const kd = highlightRows(pgdn, selColor)
  const kdEscape = kd.cells.filter(([x, y]) => x < PANE_C0 || x > PANE_C1 || y >= stripRow || y < paneTop)
  check('K1 after PgDn no highlight escapes the pane', kdEscape.length === 0, `${kdEscape.length} escaped, e.g. ${JSON.stringify(kdEscape.slice(0, 4))}`)
  const ku = highlightRows(pgup, selColor)
  const kuEscape = ku.cells.filter(([x, y]) => x < PANE_C0 || x > PANE_C1 || y >= stripRow || y < paneTop)
  check('K1 after PgUp no highlight escapes the pane', kuEscape.length === 0, `${kuEscape.length} escaped, e.g. ${JSON.stringify(kuEscape.slice(0, 4))}`)
  const kuText = pgup ? textAt(pgup, ku.cells).replace(/\s+/g, ' ').trim() : ''
  check('K1 the page round-trip returns the selected text to the glass', ku.cells.length > 0 && selUnique.length > 6 && kuText.includes(selUnique.slice(0, Math.min(12, selUnique.length))), `after=${JSON.stringify(kuText.slice(0, 40))} want≈${JSON.stringify(selUnique)}`)

  const d = highlightRows(dragE, selColor)
  const dEscape = d.cells.filter(([x, y]) => x < PANE_C0 || x > PANE_C1 || y >= stripRow || y < paneTop)
  check('D1 a drag held past the top edge paints no highlight outside the pane', dEscape.length === 0, `${dEscape.length} escaped, e.g. ${JSON.stringify(dEscape.slice(0, 4))}`)
  check('D1 the drag-scrolled selection stays highlighted', d.cells.length > 0, `${d.cells.length} cells`)
  const anchorLineText = (screenRows[anchor.row] ?? '').slice(PANE_C0, PANE_C0 + 34).trim()
  const anchorRowNow = dragE && anchorLineText.length > 8 ? dragE.rows.findIndex(r => r.includes(anchorLineText)) : -1
  check('D1 the anchor line moved with the scrolled content and stays highlighted', anchorRowNow > anchor.row && d.rows.includes(anchorRowNow), `anchor line ${JSON.stringify(anchorLineText)} row ${anchor.row} → ${anchorRowNow}; highlighted rows ${d.rows.join(',')}`)

  console.log(`\n  screen learned: tail ${tailRow}, pane rows ${paneTop}..${paneBottom}, strip ${stripRow}`)
} finally {
  run.cleanup()
}

if (failures > 0) {
  console.log(`\nselect scroll drive: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nselect scroll drive: green (${checks} checks)`)
process.exit(0)
