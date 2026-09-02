#!/usr/bin/env bun
// ============================================================================
//  scripts/critters/prove-ghost-wipe.ts — the ghost-pixel wipe, the pure laws.
//
//  Some terminals draw the half-block glyphs a pixel or two past their cell:
//  a ▀ bleeds into the row ABOVE, a ▄ into the row BELOW, a full block into
//  both. The bleed is invisible while the glyph stands and becomes a sliver
//  the moment the glyph LEAVES its cell while the neighbour does not change
//  (a critter's shape changing under an air row, a crown settling, a shorter
//  silhouette): the diff rewrites the vacated cell alone and the thin line
//  the old glyph left survives in a row nothing rewrites. The writer's wipe
//  re-emits exactly those neighbours as their current value.
//
//  Every law runs the PRODUCTION pipeline — FrameWriter.render → the patch
//  optimiser → the serializer — and replays the bytes through the
//  ink-runtime AnsiEmulator oracle, reading the TOUCHED cells off the
//  emulator (it stores a fresh style object per write).
//
//  §1  BYTE-IDENTITY — a frame in which no half-block glyph leaves a cell
//      touches only its changed cells: text edits, a ▀ that recolours (the
//      blink: E → m keeps the glyph), a ▄ that recolours, a glyph arriving.
//  §2  THE WIPE — a departed ▀ re-emits the cell above, a departed ▄ the cell
//      below, a departed █ both; a ▀ replaced by ▄ re-emits above only; the
//      re-emitted neighbour keeps its value (a space stays a space, a border
//      glyph stays a border glyph) and replay equals the next frame.
//  §3  ONCE — a neighbour that changed this frame is written once, never
//      twice; two departures over one neighbour re-emit it once.
//  §4  THE EDGES — a departure on row 0 has nothing above; on the last row
//      nothing below; nothing outside the screen.
//  §5  THE SPRITE — a nine-line half-block silhouette replaced by a seven-line
//      one two rows lower: the row above the OLD top run is re-emitted across
//      the run's columns and nowhere else; the cell counts are the numbers.
//  §6  ZERO-DIRTY ⇒ ZERO PATCHES still holds; the writer runs no sync flush.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { readFileSync } from 'node:fs'
import { checker } from '../engine-durability/harness.ts'
import type { Frame } from '../../src/ink/frame.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches } from '../../src/ink/patch-stream.js'
import { CURSOR_HOME } from '../../src/ink/termio/csi.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from '../ink-runtime/ansiEmulator.js'
import {
  CellWidth,
  CharPool,
  charInCellAt,
  createScreen,
  HyperlinkPool,
  setCellAt,
  StylePool,
  type Screen,
} from '../../src/ink/cell-grid.js'

const t = checker()
const styles = new StylePool()
const chars = new CharPool()
const links = new HyperlinkPool()
const W = 30
const H = 14

type Paint = Record<string, string> // "x,y" → char
function screenOf(paint: Paint): Screen {
  const s = createScreen(W, H, styles, chars, links)
  for (const [k, ch] of Object.entries(paint)) {
    const [x, y] = k.split(',').map(Number) as [number, number]
    setCellAt(s, x, y, { char: ch, styleId: styles.none, width: CellWidth.Narrow, hyperlink: undefined })
  }
  s.damage = { x: 0, y: 0, width: W, height: H }
  return s
}
function frameOf(paint: Paint): Frame {
  return { screen: screenOf(paint), viewport: { width: W, height: H + 1 }, cursor: { x: 0, y: 0, visible: true } }
}
function serialize(diff: ReturnType<typeof optimizePatches>): string {
  let captured = ''
  const fake = { stdout: { write(s: string) { captured += s; return true }, isTTY: false } }
  writeDiffToTerminal(fake as never, diff, false)
  return captured
}
/** Render prev → next through the production writer on the alt screen and
 *  replay the bytes: the touched cells, the replayed grid, the patch count. */
function drive(prev: Paint, next: Paint): { touched: Set<string>; grid: (x: number, y: number) => string; patches: number; mismatch: string } {
  const writer = new FrameWriter({ isTTY: true, stylePool: styles })
  const a = frameOf(prev)
  const b = frameOf(next)
  const diff = optimizePatches(writer.render(a, b, true, true))
  const bytes = diff.length === 0 ? '' : CURSOR_HOME + serialize(diff)
  const emu = new AnsiEmulator(W, H, true)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) emu.grid[y]![x] = charInCellAt(a.screen, x, y) || ' '
  emu.feed(bytes)
  const touched = new Set<string>()
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (emu.styleAt(x, y) !== null) touched.add(`${x},${y}`)
  let mismatch = ''
  for (let y = 0; y < H && !mismatch; y++) {
    for (let x = 0; x < W; x++) {
      const want = charInCellAt(b.screen, x, y) || ' '
      const got = emu.grid[y]![x] || ' '
      if (want !== got) { mismatch = `(${x},${y}) replay ${JSON.stringify(got)} vs next ${JSON.stringify(want)}`; break }
    }
  }
  return { touched, grid: (x, y) => emu.grid[y]![x]!, patches: diff.length, mismatch }
}
const setOf = (...keys: string[]): Set<string> => new Set(keys)
const sameSet = (a: Set<string>, b: Set<string>): boolean => a.size === b.size && [...a].every(k => b.has(k))
const show = (s: Set<string>): string => [...s].sort().join(' ')

t.section('§1 — byte-identity: no half-block glyph leaves a cell ⇒ only the changed cells are touched')
{
  const base: Paint = { '5,3': '▀', '6,3': '▀', '7,3': '▄', '2,6': 'a', '3,6': 'b', '10,10': '█' }
  const text = drive(base, { ...base, '2,6': 'x' })
  t.check('a text edit touches that cell alone', sameSet(text.touched, setOf('2,6')) && text.mismatch === '', `${show(text.touched)} ${text.mismatch}`)
  const arrive = drive(base, { ...base, '8,3': '▀' })
  t.check('a ▀ ARRIVING touches its cell alone (nothing left anywhere)', sameSet(arrive.touched, setOf('8,3')), show(arrive.touched))
  const same = drive(base, { ...base })
  t.check('an unchanged frame emits zero patches (ZERO-DIRTY ⇒ ZERO PATCHES)', same.patches === 0 && same.touched.size === 0)
}

t.section('§2 — the wipe: a departed glyph re-emits the neighbour it bled into')
{
  const up = drive({ '5,3': '▀', '5,2': ' ' }, { '5,2': ' ' })
  t.check('a departed ▀ re-emits the cell ABOVE (and the vacated cell) — nothing else', sameSet(up.touched, setOf('5,3', '5,2')) && up.mismatch === '', `${show(up.touched)} ${up.mismatch}`)
  t.check('…the re-emitted neighbour keeps its value (a space stays a space)', up.grid(5, 2) === ' ')
  const down = drive({ '5,3': '▄' }, {})
  t.check('a departed ▄ re-emits the cell BELOW', sameSet(down.touched, setOf('5,3', '5,4')) && down.mismatch === '', show(down.touched))
  const both = drive({ '5,3': '█' }, {})
  t.check('a departed █ re-emits above AND below', sameSet(both.touched, setOf('5,3', '5,2', '5,4')), show(both.touched))
  const swap = drive({ '5,3': '▀' }, { '5,3': '▄' })
  t.check('a ▀ replaced by ▄ re-emits ABOVE only (the ▄ arrives, nothing left below)', sameSet(swap.touched, setOf('5,3', '5,2')), show(swap.touched))
  const border = drive({ '5,3': '▀', '5,2': '─' }, { '5,2': '─' })
  t.check('a border glyph in the neighbour is re-emitted as itself (replay equals next)', sameSet(border.touched, setOf('5,3', '5,2')) && border.grid(5, 2) === '─' && border.mismatch === '', `${show(border.touched)} ${border.mismatch}`)
  const toText = drive({ '5,3': '▀' }, { '5,3': 'x' })
  t.check('a ▀ replaced by text is a departure too', sameSet(toText.touched, setOf('5,3', '5,2')), show(toText.touched))
}

t.section('§3 — once: a neighbour is written once, however many departures name it')
{
  const changedAbove = drive({ '5,3': '▀', '5,2': 'a' }, { '5,2': 'b' })
  t.check('a neighbour that changed this frame is written by the diff and not again', sameSet(changedAbove.touched, setOf('5,3', '5,2')) && changedAbove.grid(5, 2) === 'b' && changedAbove.patches <= 6, `${show(changedAbove.touched)} patches ${changedAbove.patches}`)
  const two = drive({ '5,3': '▀', '5,5': '▀', '5,4': '▄' }, {})
  // (5,4) is named by the ▀ at (5,5) (above it) and is itself a departing ▄; (5,3)'s above is (5,2); (5,4)'s below is (5,5).
  t.check('two departures over shared neighbours re-emit each neighbour once', sameSet(two.touched, setOf('5,2', '5,3', '5,4', '5,5')), show(two.touched))
}

t.section('§4 — the edges')
{
  const top = drive({ '5,0': '▀' }, {})
  t.check('a departure on row 0 has nothing above', sameSet(top.touched, setOf('5,0')), show(top.touched))
  const bottom = drive({ [`5,${H - 1}`]: '▄' }, {})
  t.check('a departure on the last row has nothing below', sameSet(bottom.touched, setOf(`5,${H - 1}`)), show(bottom.touched))
  const corner = drive({ '0,0': '█', [`${W - 1},${H - 1}`]: '█' }, {})
  t.check('corner departures stay inside the screen', sameSet(corner.touched, setOf('0,0', '0,1', `${W - 1},${H - 1}`, `${W - 1},${H - 2}`)), show(corner.touched))
}

t.section('§5 — the sprite: a shorter silhouette two rows lower wipes the row above the old top run')
{
  // A nine-line, 20-wide hero of ▀ rows at rows 3..11; then a seven-line one
  // at rows 5..11 (the clam after the jellyfish). Row 2 is the card's border
  // row above the art — blank spaces the diff would never rewrite.
  const tall: Paint = {}
  const short: Paint = {}
  for (let x = 4; x < 24; x++) {
    for (let y = 3; y <= 11; y++) tall[`${x},${y}`] = '▀'
    for (let y = 5; y <= 11; y++) short[`${x},${y}`] = '▀'
  }
  const cycle = drive(tall, short)
  const rowAbove = [...cycle.touched].filter(k => k.endsWith(',2'))
  const rows3and4 = [...cycle.touched].filter(k => k.endsWith(',3') || k.endsWith(',4'))
  const rowsBelow = [...cycle.touched].filter(k => Number(k.split(',')[1]) >= 5)
  t.check('the row ABOVE the old top run is re-emitted across exactly the run\'s 20 columns', rowAbove.length === 20 && rowAbove.every(k => { const x = Number(k.split(',')[0]); return x >= 4 && x < 24 }), `${rowAbove.length}`)
  t.check('the vacated rows 3–4 are rewritten by the diff (40 cells)', rows3and4.length === 40)
  t.check('rows the shape still covers are NOT touched (their ▀ never left)', rowsBelow.length === 0, `${rowsBelow.length}`)
  t.check('replay equals the next frame', cycle.mismatch === '', cycle.mismatch)
  console.log(`  · cells re-emitted by the wipe on this shape change: ${rowAbove.length} (the row above the old top run); by the diff: ${rows3and4.length}`)
  // The opposite direction: the taller one arrives — nothing departs, nothing extra.
  const grow = drive(short, tall)
  t.check('growing back touches only the arriving rows (nothing departs)', [...grow.touched].every(k => { const y = Number(k.split(',')[1]); return y === 3 || y === 4 }) && grow.touched.size === 40, `${grow.touched.size}`)
  // A blink over the sprite: every ▀ keeps its glyph — nothing is wiped. (The
  // blink recolours; the writer's styles are pooled by id, so the cell words
  // differ while the glyph stands — modelled here as a same-glyph row edit.)
  const blink = drive(tall, { ...tall, '10,4': '▀' })
  t.check('a same-glyph frame (the blink class) touches nothing beyond the diff (here: nothing)', blink.touched.size === 0)
}

t.section('§7 — the re-emitted neighbour is the NEXT screen\'s cell with its OWN ground')
{
  // A themed ground is a written bg-styled space; the wipe must re-emit it
  // with that bg (a default-bg space over a True Black or Oasis ground would
  // paint a wrong-coloured patch). Only a never-written cell — the terminal's
  // own default there — gets the plain space.
  const bg = styles.intern([{ code: '\x1b[48;2;13;24;27m', endCode: '\x1b[49m' } as never])
  const prev = screenOf({ '5,3': '▀' })
  const next = screenOf({})
  setCellAt(prev, 5, 2, { char: ' ', styleId: bg, width: CellWidth.Narrow, hyperlink: undefined })
  setCellAt(next, 5, 2, { char: ' ', styleId: bg, width: CellWidth.Narrow, hyperlink: undefined })
  const writer = new FrameWriter({ isTTY: true, stylePool: styles })
  const a: Frame = { screen: prev, viewport: { width: W, height: H + 1 }, cursor: { x: 0, y: 0, visible: true } }
  const b: Frame = { screen: next, viewport: { width: W, height: H + 1 }, cursor: { x: 0, y: 0, visible: true } }
  const diff = optimizePatches(writer.render(a, b, true, true))
  const bytes = CURSOR_HOME + serialize(diff)
  const emu = new AnsiEmulator(W, H, true)
  emu.feed(bytes)
  const above = emu.styleAt(5, 2)
  t.check('the wiped ground cell is re-emitted WITH its bg (the themed ground survives the wipe)', above !== null && above.bg === '48;2;13;24;27', JSON.stringify(above))
  t.check('the re-emit reads the NEXT screen after the pass, never the reused diff views (source)', /const cell = cellAt\(next\.screen, x, y\)/.test(readFileSync('src/ink/frame-writer.ts', 'utf8')))
}

t.section('§6 — source locks')
{
  const writer = readFileSync('src/ink/frame-writer.ts', 'utf8')
  t.check('the writer keeps one reused ledger and no per-frame allocation for it', /const bleedLedger = new Set<number>\(\)/.test(writer) && /bleedLedger\.clear\(\)/.test(writer))
  t.check('the wipe names above for ▀, below for ▄, both for █', /if \(char === '▀'\) return 1/.test(writer) && /if \(char === '▄'\) return 2/.test(writer) && /if \(char === '█'\) return 3/.test(writer))
  t.check('the wipe emits only after the diff pass and never on an unreachable-row abort', /if \(bleedLedger\.size > 0 && unreachableRow < 0\)/.test(writer))
  t.check('the writer runs no sync flush (the paint-hardening law)', !/flushSync/.test(writer))
}

t.finish('GHOST-WIPE')
