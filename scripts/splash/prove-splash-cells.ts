#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../assets/splash/splash-core.mjs'
import { AnsiEmulator, defaultSgr, type SgrState } from '../ink-runtime/ansiEmulator.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
function finish(): never {
  console.log(`\n${failures === 0 ? '✅ splash cells GREEN' : `❌ splash cells RED — ${failures} failure(s)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

const ROOT = join(import.meta.dir, '..', '..')
const src = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

console.log('============================================================')
console.log(' splash — the trace frames go out as cells: the same frame in fewer bytes')
console.log('============================================================')

section('C1 the cell emitter exists in the core')
check('splash-core exports emitCells (the ripple paints through it)', typeof core.emitCells === 'function', 'absent: every trail cell still goes out as address + colour + glyph + reset')
if (typeof core.emitCells !== 'function') finish()
const emitCells = core.emitCells as (cells: readonly { x: number; y: number; sgr: string; ch: string }[]) => string

type Cell = { x: number; y: number; sgr: string; ch: string }
const RESET = '\x1b[0m'
const at = (x: number, y: number): string => `\x1b[${y + 1};${x + 1}H`
const naive = (cells: readonly Cell[]): string => {
  let out = ''
  for (const c of cells) out += c.sgr === '' ? at(c.x, c.y) + c.ch : at(c.x, c.y) + c.sgr + c.ch + RESET
  return out
}
const render = (cols: number, rows: number, bytes: string): { text: string[]; styles: Array<Array<SgrState | null>>; sgr: SgrState } => {
  const emu = new AnsiEmulator(cols, rows, true)
  emu.feed(bytes)
  return { text: emu.lines(), styles: emu.cellStyles, sgr: emu.sgr }
}
const sameStyle = (a: SgrState | null, b: SgrState | null): boolean => JSON.stringify(a) === JSON.stringify(b)
const sameFrame = (cols: number, rows: number, a: ReturnType<typeof render>, b: ReturnType<typeof render>): string | null => {
  for (let y = 0; y < rows; y++) {
    if (a.text[y] !== b.text[y]) return `row ${y} text: ${JSON.stringify(a.text[y])} vs ${JSON.stringify(b.text[y])}`
    for (let x = 0; x < cols; x++) {
      if (!sameStyle(a.styles[y]![x]!, b.styles[y]![x]!)) return `cell ${x},${y} style: ${JSON.stringify(a.styles[y]![x])} vs ${JSON.stringify(b.styles[y]![x])}`
    }
  }
  return null
}

let seed = 20261005
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 2 ** 32
}
const GLYPHS = '{}();=<>+*#$_/\\|·'
const palette: string[] = []
for (let i = 0; i < 17; i++) palette.push(`\x1b[38;2;${Math.round(rnd() * 255)};${Math.round(rnd() * 255)};${Math.round(rnd() * 255)}m`)
const frameOf = (cols: number, rows: number, n: number, erases: number): Cell[] => {
  const cells: Cell[] = []
  for (let i = 0; i < n; i++) {
    const edge = rnd() < 0.08
    const x = edge ? cols - 1 : Math.floor(rnd() * cols)
    const y = Math.floor(rnd() * rows)
    const erase = rnd() < erases
    cells.push({ x, y, sgr: erase ? '' : palette[Math.floor(rnd() * palette.length)]!, ch: erase ? ' ' : GLYPHS[Math.floor(rnd() * GLYPHS.length)]! })
    if (rnd() < 0.05 && cells.length > 1) {
      const over = cells[Math.floor(rnd() * (cells.length - 1))]!
      cells.push({ x: over.x, y: over.y, sgr: palette[Math.floor(rnd() * palette.length)]!, ch: GLYPHS[Math.floor(rnd() * GLYPHS.length)]! })
    }
  }
  return cells
}

section('C2 two hundred seeded frames: the compact emission renders the naive one cell for cell')
{
  let identical = 0
  let shorter = 0
  let firstDiff = ''
  const ratios: number[] = []
  let cellsTotal = 0
  for (let f = 0; f < 200; f++) {
    const cols = 24 + Math.floor(rnd() * 177)
    const rows = 10 + Math.floor(rnd() * 51)
    const n = 1 + Math.floor(rnd() * 1400)
    const cells = frameOf(cols, rows, n, f % 4 === 0 ? 0.3 : 0)
    cellsTotal += cells.length
    const a = naive(cells)
    const b = emitCells(cells)
    let diff: string | null
    try {
      diff = sameFrame(cols, rows, render(cols, rows, a), render(cols, rows, b))
    } catch (e) {
      diff = `the emulator refused the bytes: ${(e as Error).message}`
    }
    if (diff === null) identical++
    else if (firstDiff === '') firstDiff = `frame ${f} (${cols}x${rows}, ${cells.length} cells): ${diff}`
    if (b.length <= a.length) shorter++
    ratios.push(a.length / Math.max(1, b.length))
  }
  ratios.sort((p, q) => p - q)
  check(`every frame renders identically (glyph, colour, attributes per cell; no reliance on wrap) — ${identical}/200 over ${cellsTotal} cells`, identical === 200, firstDiff)
  check('no frame grows', shorter === 200, `${shorter}/200`)
  check(`the median frame is at least three times smaller (naive/compact median ${ratios[100]!.toFixed(2)}×, min ${ratios[0]!.toFixed(2)}×)`, ratios[100]! >= 3)
}

section('C3 the shapes a frame can take')
{
  const cols = 40
  const rows = 12
  const red = palette[0]!
  const blue = palette[1]!
  const edgeRun: Cell[] = [
    { x: 38, y: 3, sgr: red, ch: '#' },
    { x: 39, y: 3, sgr: red, ch: '#' },
    { x: 0, y: 4, sgr: red, ch: '#' },
    { x: 39, y: 5, sgr: red, ch: '*' },
    { x: 37, y: 5, sgr: red, ch: '*' },
  ]
  const a = render(cols, rows, naive(edgeRun))
  const b = render(cols, rows, emitCells(edgeRun))
  check('a run that ends on the last column never wraps into the next row (the cell after it is addressed)', sameFrame(cols, rows, a, b) === null && b.text[4] === '#')
  check('a leftward neighbour on the same row is re-addressed, never overwritten in place', b.text[5]!.indexOf('*') === 37 && b.text[5]!.lastIndexOf('*') === 39)
  const bytes = emitCells(edgeRun)
  check('right-adjacent cells of one colour ride without an address between them', bytes.includes('\x1b[4;39H##'), JSON.stringify(bytes))
  check('one colour sequence for a one-colour frame, and one reset at its end', bytes.split(red).length === 2 && bytes.endsWith(RESET) && bytes.split(RESET).length === 2)
  const overlap: Cell[] = [
    { x: 5, y: 1, sgr: blue, ch: 'A' },
    { x: 5, y: 1, sgr: red, ch: 'B' },
    { x: 6, y: 1, sgr: red, ch: 'C' },
    { x: 6, y: 1, sgr: blue, ch: 'D' },
  ]
  const o = render(cols, rows, emitCells(overlap))
  check('a cell painted twice in one frame keeps its LAST paint (the later path wins, as before)', o.text[1] === '     BD' && o.styles[1]![5]!.fg === red.slice(2, -1) && o.styles[1]![6]!.fg === blue.slice(2, -1), JSON.stringify(o.text[1]))
  const erase: Cell[] = [
    { x: 2, y: 2, sgr: red, ch: 'x' },
    { x: 3, y: 2, sgr: '', ch: ' ' },
    { x: 4, y: 2, sgr: red, ch: 'y' },
  ]
  const e = render(cols, rows, emitCells(erase))
  check('an erased cell carries the default attributes (the fade paints its erasures with nothing on)', sameStyle(e.styles[2]![3]!, defaultSgr()) && e.styles[2]![2]!.fg === red.slice(2, -1) && e.styles[2]![4]!.fg === red.slice(2, -1))
  check('the terminal is left with default attributes after a frame', sameStyle(e.sgr, defaultSgr()) && sameStyle(render(cols, rows, emitCells(edgeRun)).sgr, defaultSgr()))
  const plain = emitCells([{ x: 1, y: 1, sgr: '', ch: 'q' }, { x: 2, y: 1, sgr: '', ch: 'r' }])
  check('a frame without colour (NO_COLOR) carries no colour byte and no reset', !plain.includes('\x1b[0m') && !plain.includes('m') && plain === '\x1b[2;2Hqr', JSON.stringify(plain))
  check('an empty frame is empty', emitCells([]) === '')
}

section('C4 the ripple paints through the emitter')
{
  const driver = src('assets/splash/mercury-splash.mjs')
  check('the driver imports emitCells from the one core', /import \{[^}]*\bemitCells\b[^}]*\} from '\.\/splash-core\.mjs'/.test(driver))
  const ripple = driver.slice(driver.indexOf('async function ripple()'), driver.indexOf('const rippleEnabled ='))
  check('the trace frame collects cells and emits them once inside its sync bracket', /const cells = \[\]/.test(ripple) && /'\\x1b\[\?2026h' \+ emitCells\(cells\) \+ \(HERO \? '' : HOLD_BRAND\)/.test(ripple))
  check('the settle fade emits its cohort and its erasures as cells', /sgr: '', ch: ' '/.test(ripple) && /'\\x1b\[\?2026h' \+ emitCells\(cells\)\n/.test(ripple))
  check('the resize reseat repaints the residue as cells', /emitCells\(residue\.map\(/.test(ripple))
  check('no trail cell goes out as address + colour + glyph + reset any more', !/at\(cell\.x, cell\.y\) \+ rgbFg\(/.test(ripple) && !/at\(c\.x, c\.y\) \+ rgbFg\(/.test(ripple) && !/at\(c\.x, c\.y\) \+ ' '/.test(ripple))
  const coreSrc = src('assets/splash/splash-core.mjs')
  check('the emitter is pure (no process, no I/O) and orders colour first, then row, then column', /export function emitCells\(cells\)/.test(coreSrc) && /a\.sgr < b\.sgr \? -1 : a\.sgr > b\.sgr \? 1 : a\.y - b\.y \|\| a\.x - b\.x/.test(coreSrc))
}
finish()
