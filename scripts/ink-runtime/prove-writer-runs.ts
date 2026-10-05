import type { Frame } from '../../src/ink/frame.js'
import type { DOMElement } from '../../src/ink/dom.js'
import type { TextStyles } from '../../src/ink/styles.js'
import type { ComposeContext, SceneNode } from './frameHarness.js'

process.env.FORCE_COLOR = '3'
const { FrameWriter } = await import('../../src/ink/frame-writer.js')
const { emptyFrame } = await import('../../src/ink/frame.js')
const { optimizePatches } = await import('../../src/ink/patch-stream.js')
const { writeDiffToTerminal } = await import('../../src/ink/session/delivery.js')
const { appendChildNode, createNode, setTextStyles } = await import('../../src/ink/dom.js')
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { AnsiEmulator } = await import('./ansiEmulator.js')
const { applySceneStyle, buildDom, composeScene, makeContext } = await import('./frameHarness.js')

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

type Writer = InstanceType<typeof FrameWriter>
function serialize(patches: ReturnType<Writer['render']>): string {
  let bytes = ''
  writeDiffToTerminal({ stdout: { isTTY: false, write(value: string) { bytes += value; return true } } } as never, optimizePatches(patches), true)
  return bytes
}
type StyledNode = SceneNode & { textStyles?: TextStyles; children?: StyledNode[] }
const text = (value: string, textStyles?: TextStyles): StyledNode => ({ kind: 'text', text: value, style: { textWrap: 'truncate' }, textStyles })
const column = (...children: StyledNode[]): StyledNode => ({ kind: 'box', style: { flexDirection: 'column' }, children })
const row = (...children: StyledNode[]): StyledNode => ({ kind: 'box', children })
function styleDom(node: DOMElement, spec: StyledNode): void {
  if (spec.kind === 'text' && spec.textStyles) setTextStyles(node, spec.textStyles)
  const children = node.childNodes.filter(child => child.nodeName !== '#text') as DOMElement[]
  spec.children?.forEach((child, index) => { if (children[index]) styleDom(children[index]!, child) })
}
function composeStyled(spec: StyledNode, cols: number, rows: number, ctx: ComposeContext): Frame {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
  const dom = buildDom(spec)
  styleDom(dom, spec)
  appendChildNode(root, dom)
  root.layoutNode!.calculateLayout(cols, rows)
  const front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  return createRenderer(root, ctx.stylePool)({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: true }).frame
}

const COLS = 177
const ROWS = 49
const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'the', 'lazy', 'dog', 'and', 'the', 'engine', 'paints', 'rows', 'not', 'cells']
function line(seed: number): string {
  let out = ''
  for (let index = 0; out.length < COLS - 1; index++) out += (out ? ' ' : '') + words[(seed * 7 + index * 3) % words.length]!
  return out.slice(0, COLS - 1)
}
const screen = column(...Array.from({ length: ROWS }, (_, index) => text(line(index))))
const styledScreen = column(...Array.from({ length: ROWS }, (_, index) => row(text(line(index).slice(0, 60), { color: '#dd4444' }), text(line(index).slice(60, 120), { bold: true }), text(line(index).slice(120), { color: '#4488dd' }))))

function fullRepaint(root: StyledNode, name: string, ctx: ComposeContext = makeContext()): { frame: Frame; patches: ReturnType<Writer['render']>; bytes: string; terminal: InstanceType<typeof AnsiEmulator> } {
  const frame = composeStyled(root, COLS, ROWS, ctx)
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const blank = emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const patches = writer.render(blank, frame, true)
  const bytes = serialize(patches)
  const terminal = new AnsiEmulator(COLS, ROWS, true)
  terminal.feed(bytes)
  return { frame, patches, bytes, terminal }
}
function cellsOf(frame: Frame): number {
  let count = 0
  for (let y = 0; y < frame.screen.height; y++) for (let x = 0; x < frame.screen.width; x++) if ((frame.screen.cells[((y * frame.screen.width + x) << 1)] ?? 0) !== 0) count++
  return count
}

console.log('\n§1 a full repaint emits runs, not a patch per cell')
{
  const plain = fullRepaint(screen, 'plain full screen')
  const cells = cellsOf(plain.frame)
  check(`a ${COLS}x${ROWS} screen of plain text composes thousands of cells`, cells > 5000, `${cells} cells`)
  check('its full repaint is at most three patches per row (the row move, the text, the attribute reset)', plain.patches.length <= ROWS * 3 + 4, `${plain.patches.length} patches for ${cells} cells`)
  check('every row replays cell-exact', Array.from({ length: ROWS }, (_, y) => plain.terminal.rowText(y).trimEnd() === line(y).trimEnd()).every(Boolean))
  const styled = fullRepaint(styledScreen, 'styled full screen')
  const styledCells = cellsOf(styled.frame)
  check('a style change starts a new run: a screen with three styles per row stays within nine patches per row', styled.patches.length <= ROWS * 9 + 4, `${styled.patches.length} patches for ${styledCells} cells`)
  check('the styled rows replay cell-exact', Array.from({ length: ROWS }, (_, y) => styled.terminal.rowText(y).trimEnd() === line(y).trimEnd()).every(Boolean))
  const styledRuns = styled.patches.filter(patch => patch.type === 'stdout')
  check('the styled screen carries its colours', styled.bytes.includes('\x1b[38;2;221;68;68m') && styled.bytes.includes('\x1b[1m'))
  check('a run never spans a style boundary', styledRuns.every(patch => patch.type === 'stdout' && patch.content.length <= 60), `longest run ${Math.max(...styledRuns.map(patch => (patch.type === 'stdout' ? patch.content.length : 0)))}`)
}

console.log('\n§2 the shared newline patch is never extended: a main-screen paint keeps its rows apart across frames')
{
  const ctx = makeContext()
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const blank = emptyFrame(6, 40, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const first = composeScene({ name: 'first', cols: 40, rows: 6, root: column(text('alpha'), text('beta')) }, ctx)
  const second = composeScene({ name: 'second', cols: 40, rows: 6, root: column(text('alpha'), text('beta'), text('gamma')) }, ctx)
  const bytesFirst = serialize(writer.render(blank, first, false))
  const patchesSecond = writer.render(first, second, false)
  const bytesSecond = serialize(patchesSecond)
  const terminal = new AnsiEmulator(40, 6, false)
  terminal.feed(bytesFirst + bytesSecond)
  const output = [...terminal.scrollback, ...terminal.lines()].map(row => row.trimEnd()).filter(row => row !== '')
  check('the two frames leave alpha, beta and gamma on their own lines in order', output.join('|') === 'alpha|beta|gamma', output.join('|'))
  check('the growth frame paints only the new row: the newline between frames carries no earlier text', !bytesSecond.includes('alpha') && !bytesSecond.includes('beta'), JSON.stringify(bytesSecond))
  check('a newline patch stays a bare newline', patchesSecond.every(patch => patch.type !== 'stdout' || !patch.content.includes('\n') || patch.content === '\n'))
}

console.log('\n§3 the diff pass coalesces adjacent changed cells into one run')
{
  const ctx = makeContext()
  const before = composeScene({ name: 'before', cols: 40, rows: 3, root: text('hello world, hello engine') }, ctx)
  const after = composeScene({ name: 'after', cols: 40, rows: 3, root: text('HELLO world, HELLO engine') }, ctx)
  const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
  const blank = emptyFrame(3, 40, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const terminal = new AnsiEmulator(40, 3, true)
  terminal.feed(serialize(writer.render(blank, before, true)))
  const patches = writer.render(before, after, true)
  terminal.feed(serialize(patches))
  const runs = patches.filter(patch => patch.type === 'stdout').map(patch => (patch.type === 'stdout' ? patch.content : ''))
  check('two changed words become two runs, one per stretch of adjacent cells', runs.length === 2 && runs[0] === 'HELLO' && runs[1] === 'HELLO', JSON.stringify(runs))
  check('the row replays cell-exact', terminal.rowText(0).trimEnd() === 'HELLO world, HELLO engine', JSON.stringify(terminal.rowText(0)))
}

console.log(`\n${failures === 0 ? '[PASS]' : '[FAIL]'} writer runs: ${checks - failures}/${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
