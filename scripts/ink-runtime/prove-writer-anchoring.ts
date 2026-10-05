import { FrameWriter } from '../../src/ink/frame-writer.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import { optimizePatches } from '../../src/ink/patch-stream.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from './ansiEmulator.js'
import { composeScene, makeContext, type SceneNode } from './frameHarness.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const COLS = 40
const ROWS = 4
const CHA = /\x1b\[\d*G/g
const moves = (bytes: string): number => (bytes.match(CHA) ?? []).length

function serialize(patches: ReturnType<FrameWriter['render']>): string {
  let bytes = ''
  writeDiffToTerminal({ stdout: { isTTY: false, write(value: string) { bytes += value; return true } } } as never, optimizePatches(patches), true)
  return bytes
}

function paint(root: SceneNode, name: string): { bytes: string; frame: Frame; terminal: AnsiEmulator } {
  const ctx = makeContext()
  const frame = composeScene({ name, cols: COLS, rows: ROWS, root }, ctx)
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const blank = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const bytes = serialize(writer.render(blank, frame, true))
  const terminal = new AnsiEmulator(COLS, ROWS, true)
  terminal.feed(bytes)
  return { bytes, frame, terminal }
}

function repaint(before: SceneNode, after: SceneNode, name: string): { bytes: string; terminal: AnsiEmulator } {
  const ctx = makeContext()
  const first = composeScene({ name, cols: COLS, rows: ROWS, root: before }, ctx)
  const second = composeScene({ name, cols: COLS, rows: ROWS, root: after }, ctx)
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const blank = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const terminal = new AnsiEmulator(COLS, ROWS, true)
  terminal.feed(serialize(writer.render(blank, first, true)))
  const bytes = serialize(writer.render(first, second, true))
  terminal.feed(bytes)
  return { bytes, terminal }
}

const text = (value: string, style?: SceneNode['style']): SceneNode => ({ kind: 'text', text: value, style })
const row = (...children: SceneNode[]): SceneNode => ({ kind: 'box', children })
const after = (bytes: string, glyph: string): string => bytes.slice(bytes.indexOf(glyph) + glyph.length)

console.log('\n§1 a run of cells every terminal advances alike rides on one column move')
for (const [label, value] of [['printable ASCII', 'abcdefghijk'], ['box drawing', '\u2500\u2500\u2502\u2500\u2500']] as const) {
  const { bytes, terminal } = paint(text(value), label)
  check(`${label}: at most one column move for ${JSON.stringify(value)}`, moves(bytes) <= 1, `${moves(bytes)} moves`)
  check(`${label}: the row replays cell-exact`, terminal.rowText(0).trimEnd() === value, JSON.stringify(terminal.rowText(0)))
}
{
  const { bytes, terminal } = paint(text('a b c d e'), 'gaps')
  check('a blank cell is never written to bridge a gap: one column move to the first cell and one per gap', moves(bytes) === 5 && terminal.rowText(0).trimEnd() === 'a b c d e', `${moves(bytes)} moves, ${JSON.stringify(terminal.rowText(0))}`)
}
{
  const { bytes, terminal } = paint(row(text('ab', { color: 'red' }), text('cd', { color: 'blue' }), text('ef', { bold: true })), 'styled run')
  check('a style change between agreed cells is an SGR, never a column move', moves(bytes) <= 1 && terminal.rowText(0).trimEnd() === 'abcdef', `${moves(bytes)} moves, ${JSON.stringify(terminal.rowText(0))}`)
}

console.log('\n§2 the cell after a glyph whose width a terminal may dispute is placed absolutely')
for (const [label, glyph] of [['Latin-1 (é)', '\u00e9'], ['CJK wide (中)', '\u4e2d'], ['half-block (▄)', '\u2584'], ['middle dot (·)', '\u00b7'], ['sextant (U+1FB00)', '\u{1FB00}']] as const) {
  const { bytes, terminal } = paint(text(`A${glyph}B`), label)
  check(`${label}: the next cell follows an absolute column move`, /^\x1b\[\d+G/.test(after(bytes, glyph)), JSON.stringify(after(bytes, glyph).slice(0, 12)))
  if (glyph.length === 1) check(`${label}: the row replays cell-exact`, terminal.rowText(0).trimEnd() === `A${glyph}B`, JSON.stringify(terminal.rowText(0)))
}
{
  const { bytes, terminal } = paint(text('ab\u4e2dcd'), 'mixed row')
  const tail = after(bytes, '\u4e2d')
  check('a mixed row moves once at its start and once after the wide glyph, never between agreed cells', moves(bytes) === 2 && /^\x1b\[\d+G/.test(tail) && !/\x1b\[\d*G/.test(tail.replace(/^\x1b\[\d+G/, '')), `${moves(bytes)} moves; tail ${JSON.stringify(tail.slice(0, 16))}`)
  check('the mixed row replays cell-exact', terminal.rowText(0).trimEnd() === 'ab\u4e2dcd', JSON.stringify(terminal.rowText(0)))
}
{
  const glyph = '\u{1FABC}'
  const { bytes, terminal } = paint(text(`A${glyph}BC`), 'compensated emoji')
  const tail = after(bytes, glyph)
  check('a width-doubtful emoji keeps its compensation and the cells after it ride its own re-anchor: exactly one move after the glyph', (tail.match(CHA) ?? []).length === 1 && /^\x1b\[\d+G/.test(tail), JSON.stringify(tail.slice(0, 20)))
  check('the emoji row replays cell-exact', terminal.rowText(0).trimEnd() === `A${glyph}BC`, JSON.stringify(terminal.rowText(0)))
}

console.log('\n§3 the diff pass: adjacent changed cells ride together, a dispute re-anchors')
{
  const { bytes, terminal } = repaint(text('hello world'), text('HELLO world'), 'adjacent diff')
  check('five adjacent changed ASCII cells take at most one column move', moves(bytes) <= 1 && terminal.rowText(0).trimEnd() === 'HELLO world', `${moves(bytes)} moves, ${JSON.stringify(terminal.rowText(0))}`)
}
{
  const { bytes, terminal } = repaint(text('hello world'), text('hello\u4e2dworld'), 'wide diff')
  check('a changed wide glyph re-anchors the cell written after it', terminal.rowText(0).trimEnd() === 'hello\u4e2dworld' && /^\x1b\[\d+G/.test(after(bytes, '\u4e2d')), JSON.stringify(after(bytes, '\u4e2d').slice(0, 12)))
}
{
  const { bytes, terminal } = repaint(text('ab'), text('a'), 'vacated cell')
  check('a vacated cell is blanked in place and the row replays cell-exact', terminal.rowText(0).trimEnd() === 'a' && bytes.includes(' '), JSON.stringify(bytes))
}

console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} writer anchoring: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
