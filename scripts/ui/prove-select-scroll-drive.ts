#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const ROOT = join(import.meta.dir, '..', '..')
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
const BODY_C0 = 26

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
let copies: string[] = []
function attrGrab(drive: string, offsets: number[]): AttrScreen[] {
  const res = spawnSync(
    '/usr/bin/python3',
    [`${ROOT}/scripts/render-continuity/lib/attrgrab.py`, drive, String(COLS), String(ROWS), ...offsets.map(String)],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  if (res.status !== 0) throw new Error(`attrgrab failed: ${res.stderr}`)
  const payload = JSON.parse(res.stdout) as { screens: AttrScreen[]; copies?: string[] }
  copies = payload.copies ?? []
  return payload.screens
}

const silent = await runCompassArena({ sends: [], seconds: Math.ceil(SETTLE / 1000) + 3, chapters: CHAPTERS })
let anchor = { col: BODY_C0 + 6, row: 12 }
let tailRow = -1
let stripRow = ROWS - 4
let paneTop = 1
let paneBottom = ROWS - 8
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
  stripRow = final.rows.findIndex(r => r.includes('SESSIONS'))
  if (stripRow < 0) stripRow = ROWS - 8
  paneBottom = stripRow - 3
  for (let r = tailRow; r < stripRow; r++) if ((final.rows[r] ?? '')[24] === '╰') paneBottom = r - 1
  for (let r = 1; r < tailRow; r++) if ((final.rows[r] ?? '')[25] === '╰') paneTop = r + 1
  let ar = Math.max(paneTop + 1, tailRow - 4)
  while (ar > paneTop + 1 && (final.rows[ar] ?? '').slice(BODY_C0).replace(/[^A-Za-z0-9]/g, '').length < 10) ar--
  anchor = { col: BODY_C0 + 6, row: ar }
} finally {
  silent.cleanup()
}
process.stderr.write(`[select-scroll] tail row ${tailRow}; anchor (${anchor.col},${anchor.row}); pane rows ${paneTop}..${paneBottom}; strip ${stripRow}\n`)
if (anchor.row + 2 > paneBottom || paneBottom - paneTop < 8) {
  console.error(`the learned pane geometry cannot host the drive: pane ${paneTop}..${paneBottom}, anchor ${anchor.row}`)
  process.exit(1)
}

const t0 = SETTLE
const focus1 = { col: anchor.col + 24, row: anchor.row + 2 }
const span = { top: paneTop + 1, bottom: paneBottom - 2 }
const HOLD_MS = 200
const dragT = t0 + 4500
const sends: string[] = [
  `${t0}:${sgr(LEFT, anchor.col, anchor.row)}`,
  `${t0 + 60}:${sgr(LEFT | MOTION, focus1.col, focus1.row)}`,
  `${t0 + 120}:${sgr(LEFT, focus1.col, focus1.row, true)}`,
  `${t0 + 700}:${sgr(WHEEL_UP, anchor.col, anchor.row)}`,
  `${t0 + 760}:${sgr(WHEEL_UP, anchor.col, anchor.row)}`,
  `${t0 + 820}:${sgr(WHEEL_UP, anchor.col, anchor.row)}`,
  `${t0 + 1500}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 1560}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 1620}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 1680}:${sgr(WHEEL_DOWN, anchor.col, anchor.row)}`,
  `${t0 + 2400}:${sgr(LEFT, anchor.col, span.top)}`,
  `${t0 + 2460}:${sgr(LEFT | MOTION, anchor.col + 28, span.bottom)}`,
  `${t0 + 2520}:${sgr(LEFT, anchor.col + 28, span.bottom, true)}`,
  `${t0 + 3100}:${PGUP}`,
  `${t0 + 3800}:${PGDN}`,
  `${dragT}:${sgr(LEFT, anchor.col, anchor.row)}`,
  `${dragT + 40}:${sgr(LEFT | MOTION, anchor.col, 0)}`,
  `${dragT + 40 + HOLD_MS}:${sgr(LEFT, anchor.col, 0, true)}`,
]
const lastMs = dragT + 40 + HOLD_MS
const FLUX_PATH = join(mkdtempSync(join(tmpdir(), 'mercury-select-scroll-')), 'flux.json')
const run = await runCompassArena({
  sends,
  seconds: Math.ceil((lastMs + 2500) / 1000),
  chapters: CHAPTERS,
  extraEnv: { MERCURY_FLUX_PROBE: '1', MERCURY_FLUX_PROBE_TEE: FLUX_PATH, SSH_CONNECTION: '1' },
})
type Shot = { key: string; s: AttrScreen; hi: Hi; pane: { top: number; bottom: number } }
type Hi = { rows: number[]; cells: [number, number][]; texts: string[]; rowTexts: string[]; spans: Map<number, [number, number]> }
const dumps: Shot[] = []
try {
  if (run.outs.length === 0 || run.sends.length !== sends.length) {
    console.error(`the drive did not deliver every send (${run.sends.length}/${sends.length}) — ${run.driverOut.slice(-400)}`)
    process.exit(1)
  }
  const first = run.outs[0]!.ts
  const at = (i: number, slackMs: number): number => run.sends[i]!.sent - first + slackMs
  const stops = {
    pre: at(0, -5),
    sel: at(2, 280),
    wheelUp: at(5, 320),
    wheelDown: at(9, 320),
    span: at(12, 280),
    pgUp: at(13, 320),
    pgDn: at(14, 320),
    preDrag: at(15, -5),
    drag: at(17, 150),
  }
  const order = Object.keys(stops) as (keyof typeof stops)[]
  const sortedStops = order.map(k => stops[k]).sort((a, b) => a - b)
  const grabbed = attrGrab(run.paths.drive, sortedStops)
  const shot = (k: keyof typeof stops): AttrScreen => grabbed[sortedStops.indexOf(stops[k])]!
  const bgMapOf = (s: AttrScreen): Map<string, string> => new Map(s.bg.map(([x, y, c]) => [`${x},${y}`, c]))

  const paneRowsOf = (s: AttrScreen): { top: number; bottom: number } => {
    const tail = Math.max(1, s.rows.findIndex(r => r.includes(TAIL_SENTINEL)))
    const strip = (() => { const i = s.rows.findIndex(r => r.includes('SESSIONS')); return i < 0 ? stripRow : i })()
    let top = paneTop
    let bottom = paneBottom
    for (let r = 1; r < Math.max(tail, paneTop + 1); r++) if ((s.rows[r] ?? '')[25] === '╰') top = r + 1
    for (let r = Math.max(top, 1); r < strip; r++) if ((s.rows[r] ?? '')[24] === '╰') bottom = r - 1
    return { top, bottom }
  }

  const preBg = bgMapOf(shot('pre'))
  const gained = new Map<string, number>()
  for (const [x, y, c] of shot('sel').bg) {
    if (y < paneTop - 1 || y > paneBottom || x < BODY_C0) continue
    if (preBg.get(`${x},${y}`) !== c) gained.set(c, (gained.get(c) ?? 0) + 1)
  }
  let selColor: string | null = null
  let best = 0
  for (const [c, n] of gained) if (n > best) { best = n; selColor = c }

  function highlight(s: AttrScreen): Hi {
    const cells: [number, number][] = []
    const spanByRow = new Map<number, [number, number]>()
    for (const [x, y, c] of s.bg) {
      if (c !== selColor) continue
      cells.push([x, y])
      const sp = spanByRow.get(y)
      spanByRow.set(y, sp ? [Math.min(sp[0], x), Math.max(sp[1], x)] : [x, x])
    }
    const rows = [...spanByRow.keys()].sort((a, b) => a - b)
    const rowTexts = rows.map(y => (s.rows[y] ?? '').slice(spanByRow.get(y)![0], spanByRow.get(y)![1] + 1).trim())
    const texts = rowTexts.filter(t => t.length > 0).sort()
    return { rows, cells, texts, rowTexts, spans: spanByRow }
  }
  const take = (key: keyof typeof stops): Shot => {
    const s = shot(key)
    const d = { key, s, hi: highlight(s), pane: paneRowsOf(s) }
    dumps.push(d)
    return d
  }
  const sel = take('sel')
  const midRow = sel.hi.rows[Math.floor(sel.hi.rows.length / 2)] ?? anchor.row + 1
  const midXs = sel.hi.cells.filter(([, y]) => y === midRow).map(([x]) => x)
  const paneC0 = midXs.length ? Math.min(...midXs) : BODY_C0
  const paneC1 = midXs.length ? Math.max(...midXs) : COLS - 3
  const escaped = (d: Shot): [number, number][] => d.hi.cells.filter(([x, y]) => x < paneC0 || x > paneC1 || y < d.pane.top || y > d.pane.bottom)
  const sameTexts = (a: Shot, b: Shot): boolean => JSON.stringify(a.hi.texts) === JSON.stringify(b.hi.texts)
  const subsetTexts = (a: Shot, of: Shot): boolean => a.hi.texts.every(t => of.hi.texts.includes(t))
  const rowsOf = (d: Shot): string => (d.hi.rows.length ? `${d.hi.rows[0]}..${d.hi.rows[d.hi.rows.length - 1]} (${d.hi.rows.length})` : 'none')
  const esc = (d: Shot): string => `${escaped(d).length} escaped, e.g. ${JSON.stringify(escaped(d).slice(0, 4))}; pane rows ${d.pane.top}..${d.pane.bottom}; highlighted ${rowsOf(d)}`
  process.stderr.write(`[select-scroll] selection colour ${selColor} (${best} cells gained); pane cols ${paneC0}..${paneC1}; pane rows at the selection ${sel.pane.top}..${sel.pane.bottom}\n`)

  check('W0 a three-row selection stands on the transcript before any scroll', selColor !== null && sel.hi.rows.length === 3 && escaped(sel).length === 0, `rows ${rowsOf(sel)}; colour ${selColor}; ${esc(sel)}`)

  const wu = take('wheelUp')
  const wd = take('wheelDown')
  check('W1 a wheel scroll under a selection keeps the highlight (does NOT clear it)', wu.hi.cells.length > 0, 'zero highlighted cells after the wheel')
  check('W1 after the wheel up the same text is highlighted (it followed, no lag)', wu.hi.cells.length > 0 && sameTexts(wu, sel), `before ${JSON.stringify(sel.hi.texts)} after ${JSON.stringify(wu.hi.texts)} rows ${rowsOf(wu)}`)
  check('W1 after the wheel back the same text is highlighted', wd.hi.cells.length > 0 && sameTexts(wd, sel), `after ${JSON.stringify(wd.hi.texts)} rows ${rowsOf(wd)}`)
  check('W2 no highlighted cell outside the pane after the wheel up', escaped(wu).length === 0, esc(wu))
  check('W2 no highlighted cell outside the pane after the wheel back', escaped(wd).length === 0, esc(wd))

  const sp = take('span')
  const pu = take('pgUp')
  const pd = take('pgDn')
  check('K0 a pane-spanning selection stands inside the pane', sp.hi.rows.length >= 8 && escaped(sp).length === 0, esc(sp))
  check('K1 after PgUp the surviving highlight is part of the selection PgDn restores', pu.hi.cells.length > 0 && subsetTexts(pu, pd), `PgUp rows ${rowsOf(pu)} texts ${JSON.stringify(pu.hi.texts.slice(0, 3))}; PgDn texts ${pd.hi.texts.length}`)
  check('K1 after PgUp no highlighted cell outside the pane', escaped(pu).length === 0, esc(pu))
  const held = sp.hi.rowTexts.slice(0, -1).filter(t => t.length > 0)
  const missing = held.filter(t => !pd.hi.texts.includes(t))
  check('K1 PgDn restores every row the selection held (widened by at most the two edge rows)', pd.hi.cells.length > 0 && missing.length === 0 && pd.hi.texts.length <= sp.hi.texts.length + 2, `before ${sp.hi.texts.length} rows, after ${pd.hi.texts.length} rows ${rowsOf(pd)}; missing ${JSON.stringify(missing.slice(0, 2))}`)
  check('K1 after PgDn no highlighted cell outside the pane', escaped(pd).length === 0, esc(pd))

  const dr = take('drag')
  const needle = (shot('preDrag').rows[anchor.row] ?? '').slice(BODY_C0).replace(/^[^A-Za-z0-9]+/, '').slice(0, 24).trim()
  const anchorRowNow = needle.length > 8 ? dr.s.rows.findIndex(r => r.includes(needle)) : -1
  check('D1 the drag-scrolled selection is highlighted at the release', dr.hi.cells.length > 0, 'zero highlighted cells')
  check('D1 no highlighted cell above the viewport, on the rail or on the strip after the drag', escaped(dr).length === 0, esc(dr))
  check('D1 the anchor line moved down with the content and stays highlighted', anchorRowNow > anchor.row && dr.hi.rows.includes(anchorRowNow), `line ${JSON.stringify(needle)} row ${anchor.row} → ${anchorRowNow}; highlighted rows ${rowsOf(dr)}`)

  console.log(`\n  per input (highlighted rows): wheel ${rowsOf(sel)} → up ${rowsOf(wu)} → back ${rowsOf(wd)} · page ${rowsOf(sp)} → PgUp ${rowsOf(pu)} → PgDn ${rowsOf(pd)} · drag ${rowsOf(dr)} (anchor line row ${anchor.row} → ${anchorRowNow})`)
  console.log(`  pane rows ${sel.pane.top}..${sel.pane.bottom} at the selection, cols ${paneC0}..${paneC1}; tail ${tailRow}; strip ${stripRow}`)
} finally {
  run.cleanup()
}

if (failures > 0) {
  for (const d of dumps) {
    console.log(`\n┌── ${d.key} (pane rows ${d.pane.top}..${d.pane.bottom}; highlighted ${d.hi.rows.map(y => `${y}[${d.hi.spans.get(y)![0]}..${d.hi.spans.get(y)![1]}]`).join(' ')}) ──`)
    for (let y = 0; y < ROWS; y++) console.log(`│${d.hi.rows.includes(y) ? '▌' : ' '}${(d.s.rows[y] ?? '').slice(0, 118)}`)
    console.log('└──')
  }
  try {
    const dump = JSON.parse(readFileSync(FLUX_PATH, 'utf8')) as { allMarks: { k: string; t: number; v: number }[]; epochMinusPerfNow: number }
    const arms = ['', 'drag-arm', 'both-ends', 'straddle-pinned', 'anchor-outside']
    const decode = (m: { k: string; v: number }): string => {
      if (m.k === 'scroll:xlate') return `pane@${Math.floor(m.v / 1000)} painted ${(m.v % 1000) - 500}`
      if (m.k === 'selection:xlate') return `selection ${arms[Math.floor(m.v / 1000)] ?? m.v} ${(m.v % 1000) - 500}`
      return m.k
    }
    const windows: [string, number, number][] = [
      ['first selection', run.sends[0]!.sent - 20, run.sends[2]!.sent + 600],
      ['wheel', run.sends[3]!.sent - 20, run.sends[9]!.sent + 600],
      ['pane-spanning selection', run.sends[10]!.sent - 20, run.sends[12]!.sent + 600],
      ['page keys', run.sends[13]!.sent - 20, run.sends[14]!.sent + 600],
      ['drag', run.sends[15]!.sent - 20, run.sends[17]!.sent + 300],
    ]
    for (const [name, from, to] of windows) {
      const ms = dump.allMarks.filter(m => (m.k === 'scroll:xlate' || m.k === 'selection:xlate' || m.k === 'paint:entry') && m.t + dump.epochMinusPerfNow >= from && m.t + dump.epochMinusPerfNow <= to)
      console.log(`\n  flux marks · ${name}: ${ms.map(m => `${Math.round(m.t + dump.epochMinusPerfNow - from)}ms ${decode(m)}`).join(' | ')}`)
    }
  } catch (e) {
    console.log(`  (no flux dump: ${e instanceof Error ? e.message : String(e)})`)
  }
  if (copies.length > 0) console.log(`\n  copies on the wire (OSC 52), newest last: ${copies.map(c => JSON.stringify(c.slice(0, 60))).join(' | ')}`)
  console.log(`\nselect scroll drive: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nselect scroll drive: green (${checks} checks)`)
process.exit(0)
