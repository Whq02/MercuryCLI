#!/usr/bin/env bun
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const ROOT = resolve(import.meta.dirname, '..', '..')
const DIST = resolve(arg('--dist') ?? resolve(ROOT, 'dist', 'mercury.mjs'))
const ONLY = new Set((arg('--only') ?? '1,2,3,4').split(','))
const SCRATCH = mkdtempSync(join(tmpdir(), 'wire-census-'))
const COMPOSED_TEE = join(SCRATCH, 'composed.jsonl')
process.env.INK_COMPOSED_TEE = COMPOSED_TEE
process.env.INK_WRITE_TEE = join(SCRATCH, 'writes.jsonl')
process.env.INK_WRITE_TEE_FULL = '1'

const { pinSourceRef } = await import('../lib/settingsPopupHarness.ts')
pinSourceRef()

const grid = await import('../../src/ink/cell-grid.js')
const { CellWidth, CharPool, HyperlinkPool, StylePool, blitRegion, cellAt, charInCellAt, clearRegion, createScreen, setCellAt, setCellStyleId, shiftRows } = grid
type Screen = import('../../src/ink/cell-grid.js').Screen
type Cell = import('../../src/ink/cell-grid.js').Cell
const { FrameWriter } = await import('../../src/ink/frame-writer.js')
const { optimizePatches } = await import('../../src/ink/patch-stream.js')
const { writeDiffToTerminal } = await import('../../src/ink/session/delivery.js')
const { CURSOR_HOME } = await import('../../src/ink/termio/csi.js')
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
type Diff = import('../../src/ink/frame.js').Diff
const { AnsiEmulator, defaultSgr, sgrStateOfStyleString } = await import('../ink-runtime/ansiEmulator.js')
type Emulator = InstanceType<typeof AnsiEmulator>
type SgrState = import('../ink-runtime/ansiEmulator.js').SgrState
type AnsiCode = import('@alcalzone/ansi-tokenize').AnsiCode

let failures = 0
let checks = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail.slice(0, 600)}`}`)
  if (!ok) failures++
}
const section = (title: string): void => console.log(`\n${title}`)

const ESC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b\[[0-9;?<=>]*[A-Za-z@`~]|\x1b[()][0-9A-Za-z]|\x1b[A-Za-z=><78]/g
function wireCells(bytes: string): number {
  let cells = 0
  for (const ch of bytes.replace(ESC_RE, '')) {
    const code = ch.codePointAt(0)!
    if (code >= 0x20 && code !== 0x7f) cells++
  }
  return cells
}
const clearCount = (bytes: string): number => (bytes.match(/\x1b\[2J|\x1b\[3J/g) ?? []).length

function serialize(diff: Diff): string {
  let captured = ''
  const fake = { stdout: { write(s: string) { captured += s; return true }, isTTY: false } }
  writeDiffToTerminal(fake as never, diff, false)
  return captured
}

const HOME = { x: 0, y: 0, visible: true }
const framed = (screen: Screen, rows: number, columns = screen.width): Frame => ({ screen, viewport: { width: columns, height: rows }, cursor: HOME })

const styleStates = new WeakMap<InstanceType<typeof StylePool>, Map<number, SgrState>>()
function expectedState(pool: InstanceType<typeof StylePool>, styleId: number): SgrState {
  let states = styleStates.get(pool)
  if (!states) {
    states = new Map()
    styleStates.set(pool, states)
  }
  const known = states.get(styleId)
  if (known) return known
  const state = sgrStateOfStyleString(pool.transition(pool.none, styleId))
  states.set(styleId, state)
  return state
}
const spaceVisible = (s: SgrState): string => `${s.bg}|${s.inverse}|${s.underline}|${s.strike}`
const glyphVisible = (s: SgrState): string => `${s.fg}|${s.bg}|${s.bold}|${s.dim}|${s.italic}|${s.underline}|${s.inverse}|${s.strike}`

function terminalMismatch(screen: Screen, pool: InstanceType<typeof StylePool>, emu: Emulator, rowsBelow = true): string | null {
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)!
      if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      const glyph = cell.char === '' ? ' ' : cell.char
      const shown = emu.grid[y]?.[x] ?? ' '
      if (shown !== glyph) return `(${x},${y}) glyph ${JSON.stringify(shown)} on the terminal, ${JSON.stringify(glyph)} composed`
      const want = expectedState(pool, cell.styleId)
      const have = emu.styleAt(x, y) ?? defaultSgr()
      const same = glyph === ' ' ? spaceVisible(want) === spaceVisible(have) : glyphVisible(want) === glyphVisible(have)
      if (!same) return `(${x},${y}) ${JSON.stringify(glyph)} style ${JSON.stringify(have)} on the terminal, ${JSON.stringify(want)} composed`
      const link = cell.hyperlink ?? null
      if ((emu.linkAt(x, y) ?? null) !== link) return `(${x},${y}) link ${JSON.stringify(emu.linkAt(x, y))} on the terminal, ${JSON.stringify(link)} composed`
    }
  }
  if (rowsBelow) {
    for (let y = screen.height; y < emu.height; y++) {
      if (emu.rowText(y) !== '') return `row ${y} below the frame still shows ${JSON.stringify(emu.rowText(y))}`
    }
  }
  return null
}

function screensDiffer(a: Screen, b: Screen): string | null {
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} vs ${b.width}x${b.height}`
  const words = a.width * a.height * 2
  for (let at = 0; at < words; at++) {
    if (a.cells[at] !== b.cells[at]) {
      const cell = at >> 1
      return `cell (${cell % a.width},${Math.floor(cell / a.width)}) ${a.cells[cell << 1]}/${a.cells[(cell << 1) + 1]} vs ${b.cells[cell << 1]}/${b.cells[(cell << 1) + 1]}`
    }
  }
  return null
}

function changedCells(a: Screen, b: Screen): number {
  let n = 0
  const cells = Math.min(a.width * a.height, b.width * b.height)
  for (let c = 0; c < cells; c++) if (a.cells[c << 1] !== b.cells[c << 1] || a.cells[(c << 1) + 1] !== b.cells[(c << 1) + 1]) n++
  return n
}

if (ONLY.has('1')) {
  section('§1 the production FrameWriter: a changed cell reaches the terminal whatever the damage rect says')
  const W = 269
  const H = 70
  const pool = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  const code = (seq: string, end: string): AnsiCode => ({ type: 'ansi', code: seq, endCode: end })
  const fg = (r: number, g: number, b: number): AnsiCode => code(`\x1b[38;2;${r};${g};${b}m`, '\x1b[39m')
  const bg = (r: number, g: number, b: number): AnsiCode => code(`\x1b[48;2;${r};${g};${b}m`, '\x1b[49m')
  const BOLD = code('\x1b[1m', '\x1b[22m')
  const INVERSE = code('\x1b[7m', '\x1b[27m')
  const GROUND = bg(13, 24, 27)
  const groundId = pool.intern([GROUND])
  const inkId = pool.intern([GROUND, fg(221, 68, 68)])
  const dimId = pool.intern([GROUND, fg(113, 128, 123)])
  const boldId = pool.intern([GROUND, fg(221, 221, 221), BOLD])
  const inverseId = pool.intern([GROUND, INVERSE])
  const otherGroundId = pool.intern([bg(32, 24, 16)])
  const narrow = (char: string, styleId: number, hyperlink?: string): Cell => ({ char, styleId, width: CellWidth.Narrow, hyperlink })
  const wide = (char: string, styleId: number): Cell => ({ char, styleId, width: CellWidth.Wide, hyperlink: undefined })
  const writeRun = (s: Screen, x: number, y: number, text: string, styleId: number, hyperlink?: string): void => {
    let cx = x
    for (const ch of text) {
      setCellAt(s, cx, y, narrow(ch, styleId, hyperlink))
      cx++
    }
  }
  function base(height = H): Screen {
    const s = createScreen(W, height, pool, chars, links)
    for (let y = 0; y < height; y++) for (let x = 0; x < W; x++) setCellAt(s, x, y, narrow(' ', groundId))
    writeRun(s, 10, 2, 'Molting…', inkId)
    writeRun(s, 30, 2, '(2s)', dimId)
    setCellAt(s, 20, 4, wide('漢', inkId))
    writeRun(s, 40, 5, 'link', inkId, 'https://a.example/one')
    writeRun(s, 10, 7, 'bold', boldId)
    writeRun(s, 10, 8, '    ', inverseId)
    for (let y = 12; y < Math.min(60, height); y++) writeRun(s, 4, y, `line ${String(y).padStart(2, '0')} · steady prose that stays on the screen`, dimId)
    if (height > 60) setCellAt(s, 250, 60, narrow('A', inkId))
    return s
  }
  const copyOf = (s: Screen): Screen => {
    const c = createScreen(s.width, s.height, pool, chars, links)
    blitRegion(c, s, 0, 0, s.width, s.height)
    return c
  }
  const NONE = undefined
  const NARROW = { x: 0, y: 0, width: 10, height: 1 }
  const BOGUS = { x: 400, y: 100, width: 3, height: 3 }
  const FULL = { x: 0, y: 0, width: W, height: H }

  type Case = { name: string; mutate: (next: Screen) => void; damage: typeof NONE | typeof NARROW; cells: number }
  const cases: Case[] = [
    { name: 'a glyph at (250,60) changes and the frame carries no damage at all', mutate: s => setCellAt(s, 250, 60, narrow('X', inkId)), damage: NONE, cells: 1 },
    { name: 'the same cell changes under a narrow damage rect that names another corner', mutate: s => setCellAt(s, 250, 60, narrow('X', inkId)), damage: NARROW, cells: 1 },
    { name: 'the same cell changes under a bogus damage rect outside the grid', mutate: s => setCellAt(s, 250, 60, narrow('X', inkId)), damage: BOGUS, cells: 1 },
    { name: 'a style-only change (same glyph, new foreground) without damage', mutate: s => setCellStyleId(s, 11, 2, dimId), damage: NONE, cells: 1 },
    { name: 'a hyperlink-only change (same glyph, same style, new target) without damage', mutate: s => setCellAt(s, 40, 5, narrow('l', inkId, 'https://a.example/two')), damage: NONE, cells: 1 },
    { name: 'a label shrinks (Molting… → Hm…, the tail cleared to the ground) without damage', mutate: s => { clearRegion(s, 10, 2, 8, 1); for (let x = 10; x < 18; x++) setCellAt(s, x, 2, narrow(' ', groundId)); writeRun(s, 10, 2, 'Hm…', inkId) }, damage: NONE, cells: 8 },
    { name: 'a wide glyph becomes a narrow one without damage', mutate: s => { setCellAt(s, 20, 4, narrow('a', inkId)); setCellAt(s, 21, 4, narrow(' ', groundId)) }, damage: NONE, cells: 2 },
    { name: 'a styled glyph becomes an empty cell without damage', mutate: s => clearRegion(s, 12, 7, 1, 1), damage: NONE, cells: 1 },
    { name: 'the whole ground changes colour under a one-cell damage rect', mutate: s => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = cellAt(s, x, y)!; if (c.styleId === groundId) setCellStyleId(s, x, y, otherGroundId) } }, damage: { x: 0, y: 0, width: 1, height: 1 }, cells: -1 },
  ]
  for (const c of cases) {
    const prev = base()
    const next = copyOf(prev)
    c.mutate(next)
    const differing = changedCells(prev, next)
    prev.damage = c.damage === undefined ? undefined : { ...c.damage }
    next.damage = c.damage === undefined ? undefined : { ...c.damage }
    const writer = new FrameWriter({ isTTY: true, stylePool: pool })
    const emu = new AnsiEmulator(W, H, true)
    emu.feed(CURSOR_HOME + serialize(optimizePatches(writer.render(emptyFrame(H, W, pool, chars, links), framed(prev, H), true, true))))
    const seeded = terminalMismatch(prev, pool, emu)
    check(`${c.name}: the terminal holds the previous frame before the step`, seeded === null, seeded ?? '')
    const diff = optimizePatches(writer.render(framed(prev, H), framed(next, H), true, true))
    const bytes = diff.length === 0 ? '' : CURSOR_HOME + serialize(diff)
    emu.feed(bytes)
    const mismatch = terminalMismatch(next, pool, emu)
    check(`${c.name}: the terminal equals the composed frame afterwards`, mismatch === null, mismatch ?? '')
    const emitted = wireCells(bytes)
    const expected = c.cells < 0 ? differing : c.cells
    check(`${c.name}: exactly the ${expected} differing cell(s) crossed the wire (${emitted}), no clear`, emitted === expected && clearCount(bytes) === 0, `emitted=${emitted} differing=${differing} clears=${clearCount(bytes)} patches=${diff.length}`)
  }
  {
    const prev = base()
    const next = copyOf(prev)
    prev.damage = { ...FULL }
    next.damage = { ...FULL }
    const writer = new FrameWriter({ isTTY: true, stylePool: pool })
    writer.render(emptyFrame(H, W, pool, chars, links), framed(prev, H), true, true)
    const diff = optimizePatches(writer.render(framed(prev, H), framed(next, H), true, true))
    check('an unchanged frame under whole-screen damage emits nothing (damage never adds a cell)', diff.length === 0, `patches=${diff.length}`)
  }
  {
    const prev = base(60)
    const next = base(70)
    const writer = new FrameWriter({ isTTY: true, stylePool: pool })
    const emu = new AnsiEmulator(W, H, true)
    emu.feed(CURSOR_HOME + serialize(optimizePatches(writer.render(emptyFrame(H, W, pool, chars, links), framed(prev, H), true, true))))
    const diff = optimizePatches(writer.render(framed(prev, H), framed(next, H), true, true))
    const bytes = CURSOR_HOME + serialize(diff)
    emu.feed(bytes)
    const mismatch = terminalMismatch(next, pool, emu)
    check('the frame grows from 60 to 70 rows: the new rows arrive and the rest is untouched', mismatch === null && clearCount(bytes) === 0, mismatch ?? `clears=${clearCount(bytes)}`)
    const back = optimizePatches(writer.render(framed(next, H), framed(prev, H), true, true))
    const backBytes = CURSOR_HOME + serialize(back)
    emu.feed(backBytes)
    const shrunk = terminalMismatch(prev, pool, emu)
    check('the frame shrinks to 60 rows: the writer takes its offscreen repaint and the terminal equals the frame', shrunk === null, shrunk ?? '')
  }
  for (const trusted of [true, false]) {
    const prev = base()
    const next = copyOf(prev)
    shiftRows(next, 10, 50, 3)
    for (let y = 48; y <= 50; y++) { for (let x = 0; x < W; x++) setCellAt(next, x, y, narrow(' ', groundId)); writeRun(next, 4, y, `line ${y} · arrived with the scroll`, dimId) }
    const nextFrame: Frame = { ...framed(next, H), scrollHint: { top: 10, bottom: 50, delta: 3 } }
    const writer = new FrameWriter({ isTTY: true, stylePool: pool })
    const emu = new AnsiEmulator(W, H, true)
    emu.feed(CURSOR_HOME + serialize(optimizePatches(writer.render(emptyFrame(H, W, pool, chars, links), framed(prev, H), true, true))))
    const diff = optimizePatches(writer.render(framed(prev, H), nextFrame, true, trusted))
    const bytes = CURSOR_HOME + serialize(diff)
    emu.feed(bytes)
    const mismatch = terminalMismatch(next, pool, emu)
    const scrolled = /\x1b\[11;51r/.test(bytes)
    check(`a three-row scroll of rows 10..50 with the region scroll ${trusted ? 'trusted (the terminal scrolls, the writer mirrors it)' : 'untrusted (every moved cell is re-emitted)'}: the terminal equals the frame`, mismatch === null && scrolled === trusted && clearCount(bytes) === 0, mismatch ?? `scrolled=${scrolled} clears=${clearCount(bytes)}`)
  }
  {
    const prev = base()
    const next = copyOf(prev)
    const writer = new FrameWriter({ isTTY: true, stylePool: pool })
    const emu = new AnsiEmulator(W, H + 1, true)
    emu.feed(CURSOR_HOME + serialize(optimizePatches(writer.render(emptyFrame(H, W, pool, chars, links), framed(prev, H), true, true))))
    const diff = optimizePatches(writer.render(framed(prev, H), framed(next, H + 1), true, true))
    const bytes = CURSOR_HOME + serialize(diff)
    emu.feed(bytes)
    const mismatch = terminalMismatch(next, pool, emu)
    check('a viewport resize keeps the writer\'s full repaint and the terminal equals the frame', mismatch === null && clearCount(bytes) >= 1, mismatch ?? `clears=${clearCount(bytes)}`)
  }
}

if (ONLY.has('2')) {
  section('§2 a FullscreenLayout-shaped tree: incremental compose equals from-scratch compose, and the writer\'s bytes equal the frame')
  const { appendChildNode, createNode, createTextNode, insertBeforeNode, markDirty, removeChildNode, setAttribute, setTextNodeValue } = await import('../../src/ink/dom.js')
  type DOMElement = import('../../src/ink/dom.js').DOMElement
  const { default: createRenderer } = await import('../../src/ink/renderer.js')
  const { applySceneStyle, makeContext } = await import('../ink-runtime/frameHarness.ts')
  type ComposeContext = import('../ink-runtime/frameHarness.ts').ComposeContext
  type Styles = import('../../src/ink/styles.js').Styles
  const recess = await import('../../src/ink/recessLayer.js')

  const GROUND = '#101820'
  type Tree = {
    root: DOMElement
    render: ReturnType<typeof createRenderer>
    frames: [Frame, Frame]
    spinner: DOMElement
    label: DOMElement
    timer: DOMElement
    critter: DOMElement
    capsule: DOMElement
    rail: DOMElement
    ground: DOMElement
    transcript: DOMElement
    content: DOMElement
    items: DOMElement[]
    centre: DOMElement
    linkText: DOMElement
    popup?: DOMElement
    unregister?: () => void
  }
  function box(style: Styles, children: DOMElement[] = []): DOMElement {
    const el = createNode('ink-box')
    applySceneStyle(el, { flexDirection: 'column', flexGrow: 0, flexShrink: 0, ...style })
    for (const c of children) appendChildNode(el, c)
    return el
  }
  function text(s: string, style: Styles = {}): DOMElement {
    const el = createNode('ink-text')
    if (Object.keys(style).length > 0) applySceneStyle(el, style)
    appendChildNode(el, createTextNode(s) as never)
    return el
  }
  const textOf = (el: DOMElement): DOMElement['childNodes'][number] => el.childNodes[0]!
  const retext = (el: DOMElement, s: string): void => setTextNodeValue(textOf(el) as never, s)

  function buildTree(ctx: ComposeContext, cols: number, rows: number, withRail: boolean): Tree {
    const root = createNode('ink-root')
    applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
    const spinner = text('✹')
    const label = text('Molting…')
    const timer = text('(1s)')
    const capsule = box({ flexDirection: 'row', borderStyle: 'round', flexGrow: 1 }, [spinner, text(' '), label, text(' '), timer])
    const critter = text(' ▄▄▄ \n █▀█ \n ▀▀▀ ')
    const band = box({ flexDirection: 'row', borderStyle: 'round', width: cols }, [box({ width: 7 }, [critter]), capsule])
    const rail = box({ width: 14, overflow: 'hidden' }, [text('lanes'), text('❯ WORKBENCH'), text('  hello')])
    const link = createNode('ink-link')
    setAttribute(link, 'href', 'https://a.example/one')
    appendChildNode(link, createTextNode('a link in the prose') as never)
    const linkText = createNode('ink-text')
    appendChildNode(linkText, createTextNode('see ') as never)
    appendChildNode(linkText, link)
    const items = Array.from({ length: rows + 20 }, (_, i) => text(`line ${String(i).padStart(2, '0')} · steady prose that stays`, i % 7 === 3 ? { textWrap: 'truncate-end' } : {}))
    items.splice(5, 0, linkText)
    const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }, items)
    const transcript = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflowX: 'scroll', overflowY: 'scroll' }, [content])
    setAttribute(transcript, 'stickyScroll', true)
    const centre = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }, [band, transcript])
    const row = box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' }, withRail ? [rail, centre] : [centre])
    const footer = box({ flexDirection: 'row', width: cols }, [text('Type a prompt')])
    const ground = box({ width: cols, height: rows, overflow: 'hidden', backgroundColor: GROUND }, [row, footer])
    appendChildNode(root, ground)
    const frames: [Frame, Frame] = [emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)]
    return { root, render: createRenderer(root, ctx.stylePool), frames, spinner, label, timer, critter, capsule, rail, ground, transcript, content, items, centre, linkText }
  }
  function renderTree(tree: Tree, cols: number, rows: number, scratch: boolean, regionScroll: boolean): Frame {
    tree.root.layoutNode!.calculateLayout(cols, rows)
    const [front, back] = tree.frames
    const { frame } = tree.render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: regionScroll })
    tree.frames = [frame, front]
    return frame
  }
  type Step = { name: string; apply: (t: Tree) => void; contaminated?: boolean }
  const popupOf = (t: Tree): DOMElement => t.popup!
  const steps: Step[] = [
    { name: 'first paint', apply: () => {} },
    { name: 'spinner tick', apply: t => retext(t.spinner, '✺') },
    { name: 'spinner tick with a longer label', apply: t => { retext(t.spinner, '✹'); retext(t.label, 'Tinder-shaving…') } },
    { name: 'nothing changed', apply: () => {} },
    { name: 'label shrinks in place', apply: t => retext(t.label, 'Hm…') },
    { name: 'the counter advances', apply: t => retext(t.timer, '(2s)') },
    { name: 'the counter advances again', apply: t => retext(t.timer, '(3s)') },
    { name: 'the counter advances a third time', apply: t => retext(t.timer, '(4s)') },
    { name: 'a wide glyph enters the label', apply: t => retext(t.label, '漢字 wide') },
    { name: 'the wide glyph leaves', apply: t => retext(t.label, 'ab wide') },
    { name: 'the hyperlink changes its target', apply: t => setAttribute(t.linkText.childNodes[1] as DOMElement, 'href', 'https://a.example/two') },
    { name: 'transcript tail grows (sticky)', apply: t => { const item = text('line tail · the tail'); t.items.push(item); appendChildNode(t.content, item) } },
    { name: 'transcript tail grows again', apply: t => { const item = text('line tail · the second tail'); t.items.push(item); appendChildNode(t.content, item) } },
    { name: 'transcript tail line shrinks in place', apply: t => retext(t.items.at(-1)!, 'line tail') },
    { name: 'tail becomes two lines then one', apply: t => retext(t.items.at(-1)!, 'line tail\nmore words here') },
    { name: 'tail second line shortens', apply: t => retext(t.items.at(-1)!, 'line tail\nm') },
    { name: 'band grows a row', apply: t => retext(t.critter, ' ▄▄▄ \n █▀█ \n ▀▀▀ \n ▀ ▀ ') },
    { name: 'spinner tick after the band grew', apply: t => retext(t.spinner, '✹') },
    { name: 'band shrinks back', apply: t => retext(t.critter, ' ▄▄▄ \n █▀█ \n ▀▀▀ ') },
    { name: 'a transcript item is removed', apply: t => { const gone = t.items.splice(28, 1)[0]!; removeChildNode(t.content, gone) } },
    { name: 'a transcript item is inserted', apply: t => { const item = text('line 28 · back'); insertBeforeNode(t.content, item, t.items[28]!); t.items.splice(28, 0, item) } },
    { name: 'capsule border removed', apply: t => applySceneStyle(t.capsule, { flexDirection: 'row', flexGrow: 1 }) },
    { name: 'capsule border restored', apply: t => applySceneStyle(t.capsule, { flexDirection: 'row', borderStyle: 'round', flexGrow: 1 }) },
    { name: 'rail hidden', apply: t => applySceneStyle(t.rail, { width: 14, overflow: 'hidden', display: 'none' }) },
    { name: 'rail shown', apply: t => applySceneStyle(t.rail, { width: 14, overflow: 'hidden', display: 'flex' }) },
    { name: 'a popup opens over the transcript and the backdrop recesses', apply: t => { const popup = box({ position: 'absolute', backgroundColor: '#3a2a10', borderStyle: 'round', width: 30, height: 6 }, [text('popup line one'), text('popup line two')]); t.popup = popup; appendChildNode(t.centre, popup); t.unregister = recess.registerElevatedSurface(popup) } },
    { name: 'spinner tick with the popup open', apply: t => retext(t.spinner, '✺') },
    { name: 'popup text changes', apply: t => retext(popupOf(t).childNodes[1] as DOMElement, 'popup line changed') },
    { name: 'popup title changes', apply: t => retext(popupOf(t).childNodes[0] as DOMElement, 'popup · jev') },
    { name: 'popup closes and the recess lifts', apply: t => { t.unregister?.(); t.unregister = undefined; removeChildNode(t.centre, popupOf(t)); t.popup = undefined }, contaminated: true },
    { name: 'spinner tick after the popup', apply: t => retext(t.spinner, '✹') },
    { name: 'ground colour changes', apply: t => applySceneStyle(t.ground, { width: 0, height: 0, overflow: 'hidden', backgroundColor: '#201810' }) },
    { name: 'spinner tick on the new ground', apply: t => retext(t.spinner, '✺') },
    { name: 'transcript scrolls up by three', apply: t => { ;(t.transcript.scroll ??= {}).pendingScrollDelta = -3; t.transcript.scroll.stickyScroll = false; markDirty(t.transcript) } },
    { name: 'spinner tick while scrolled', apply: t => retext(t.spinner, '✹') },
    { name: 'nothing changed while scrolled', apply: () => {} },
    { name: 'transcript scrolls down by two', apply: t => { ;(t.transcript.scroll ??= {}).pendingScrollDelta = 2; markDirty(t.transcript) } },
    { name: 'transcript scrolls to the end', apply: t => { ;(t.transcript.scroll ??= {}).pendingScrollDelta = 99; markDirty(t.transcript) } },
  ]
  const variants: Array<{ label: string; cols: number; rows: number; withRail: boolean; regionScroll: boolean }> = [
    { label: '96x24 with a rail, rect scrolls', cols: 96, rows: 24, withRail: true, regionScroll: false },
    { label: '120x44 full width, region scrolls trusted', cols: 120, rows: 44, withRail: false, regionScroll: true },
  ]
  for (const v of variants) {
    console.log(`  ${v.label}`)
    recess.setRecessTarget({ canvas: [16, 24, 32], ink: [220, 220, 220], quantize256: false })
    const ctx = makeContext()
    const live = buildTree(ctx, v.cols, v.rows, v.withRail)
    const scratch = buildTree(ctx, v.cols, v.rows, v.withRail)
    const writer = new FrameWriter({ isTTY: true, stylePool: ctx.stylePool })
    const emu = new AnsiEmulator(v.cols, v.rows, true)
    let shown: Frame = emptyFrame(v.rows, v.cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
    let regionScrolls = 0
    for (const step of steps) {
      if (step.name === 'ground colour changes') step.apply = t => applySceneStyle(t.ground, { width: v.cols, height: v.rows, overflow: 'hidden', backgroundColor: '#201810' })
      step.apply(live)
      step.apply(scratch)
      const liveFrame = renderTree(live, v.cols, v.rows, step.contaminated === true, v.regionScroll)
      const scratchFrame = renderTree(scratch, v.cols, v.rows, true, v.regionScroll)
      const composeDiff = screensDiffer(liveFrame.screen, scratchFrame.screen)
      check(`${step.name}: the incremental compose equals the from-scratch compose`, composeDiff === null, composeDiff ?? '')
      const diff = optimizePatches(writer.render({ ...shown, cursor: HOME }, liveFrame, true, v.regionScroll))
      const bytes = diff.length === 0 ? '' : CURSOR_HOME + serialize(diff)
      if (/\x1b\[\d+;\d+r/.test(bytes)) regionScrolls++
      if (process.env.WIRE_CENSUS_DEBUG) console.log(`    · ${step.name}: hint=${JSON.stringify(liveFrame.scrollHint ?? null)} scroll=${JSON.stringify(live.transcript.scroll ?? null)} bytes=${bytes.length}`)
      emu.feed(bytes)
      const mismatch = terminalMismatch(liveFrame.screen, ctx.stylePool, emu)
      check(`${step.name}: the terminal equals the composed frame after the writer's bytes (${wireCells(bytes)} cells, ${clearCount(bytes)} clears)`, mismatch === null && clearCount(bytes) === 0, mismatch ?? `clears=${clearCount(bytes)}`)
      if (step.name === 'nothing changed' || step.name === 'nothing changed while scrolled') check(`${step.name}: nothing crosses the wire`, bytes === '', `bytes=${JSON.stringify(bytes.slice(0, 80))}`)
      if (step.name.startsWith('a popup opens')) check(`${step.name}: the recess pass was live for the popup`, recess.recessActive())
      shown = liveFrame
    }
    check(`${v.label}: the region scroll ${v.regionScroll ? 'was' : 'was never'} handed to the terminal (${regionScrolls} scrolled frames)`, v.regionScroll ? regionScrolls >= 1 : regionScrolls === 0)
    recess.setRecessTarget(null)
  }
}

if (ONLY.has('3')) {
  section('§3 the built product: an idle screen delivers nothing, a hung turn\'s ticks deliver a handful of cells, nothing repaints from scratch')
  if (!existsSync(DIST)) {
    console.error(`✗ ${DIST} missing — run \`bun run build.ts\` first, or name a bundle with --dist`)
    process.exit(2)
  }
  const { runArtifactArena } = await import('../streaming/artifactArena.ts')
  type Composed = { f?: number; ts?: number; counts?: { blit: number; write: number }; rows?: string[] }
  const srt = (xs: number[]): number[] => [...xs].sort((a, b) => a - b)
  const pct = (xs: number[], q: number): number => (xs.length === 0 ? -1 : srt(xs)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!)

  async function capture(cols: number, rows: number, kind: 'hang' | 'paced'): Promise<{ frames: Composed[]; ready: number; submit: number; complete: boolean; reason: string | null; emission: { start: number; end: number } | null; writes: Array<{ ts: number; content: string; len: number }> }> {
    const tee = join(mkdtempSync(join(SCRATCH, 'pty-')), 'composed.jsonl')
    const turn = kind === 'hang'
      ? { kind: 'hang' as const, deltas: [], whenModel: 'opus' }
      : { kind: 'paced' as const, whenModel: 'opus', deltas: Array.from({ length: 160 }, (_, i) => (i % 25 === 24 ? 'lattice.\n' : `word${i} `)), gapMs: 40 }
    const run = await runArtifactArena({ turns: [turn], sends: ['4500:hello', '5300:\\r'], seconds: kind === 'hang' ? 12 : 14, cols, rows, distPath: DIST, anchor: { needle: 'Type a prompt', atMs: 3000 }, extraEnv: { COLORTERM: 'truecolor', INK_COMPOSED_TEE: tee } })
    const frames: Composed[] = existsSync(tee) ? readFileSync(tee, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Composed).filter(r => typeof r.f === 'number') : []
    const emits = run.fixture.pacedEmits
    const emission = emits.length > 0 ? { start: Math.min(...emits.map(e => e.at)), end: Math.max(...emits.map(e => e.at)) } : null
    const writes = run.teeLines.filter(w => typeof w.ts === 'number').map(w => ({ ts: w.ts, content: w.content ?? '', len: w.len ?? 0 }))
    return { frames, ready: run.sendLog[0]?.sent ?? 0, submit: run.sendLog.at(-1)?.sent ?? 0, complete: run.outcome.complete, reason: run.outcome.reason, emission, writes }
  }

  for (const [cols, rows] of [[269, 70], [178, 51]] as const) {
    console.log(`  ${cols}x${rows}, truecolor ground, a hung turn (the spinner ticks)`)
    const { frames, ready, submit, complete, reason, writes } = await capture(cols, rows, 'hang')
    check(`${cols}: the capture completed`, complete, reason ?? '')
    const idle = writes.filter(w => w.ts >= ready - 1500 && w.ts < ready)
    check(`${cols}: the settled composer delivers nothing while idle (${idle.length} deliveries, ${idle.reduce((n, w) => n + wireCells(w.content), 0)} cells in the 1.5 s before the first key)`, idle.reduce((n, w) => n + wireCells(w.content), 0) === 0)
    const steady = frames.filter(r => (r.ts ?? 0) >= submit + 1500)
    const deliveries = writes.filter(w => w.ts >= submit + 1500)
    check(`${cols}: enough steady frames (${steady.length}) and deliveries (${deliveries.length})`, steady.length >= 20 && deliveries.length >= 10)
    const cells = deliveries.map(w => wireCells(w.content))
    check(`${cols}: a tick delivers a handful of cells — p50 ${pct(cells, 0.5)}, max ${Math.max(0, ...cells)} (the spinner glyph, the elapsed digits, a shimmer letter; cap 8)`, pct(cells, 0.5) <= 4 && Math.max(0, ...cells) <= 8)
    const clears = deliveries.reduce((n, w) => n + clearCount(w.content), 0)
    const wholeScreen = deliveries.filter(w => wireCells(w.content) >= (cols * rows) / 4)
    check(`${cols}: no steady frame is repainted from scratch (${clears} clears, ${wholeScreen.length} whole-screen runs)`, clears === 0 && wholeScreen.length === 0)
    check(`${cols}: deliveries never outnumber composed frames (${deliveries.length} ≤ ${steady.length})`, deliveries.length <= steady.length)
    const bytes = deliveries.reduce((n, w) => n + w.len, 0)
    console.log(`    ${deliveries.length} deliveries, ${bytes} bytes over ${((steady.at(-1)?.ts ?? 0) - (steady[0]?.ts ?? 0)) / 1000} s; compose write p50 ${pct(steady.map(r => r.counts?.write ?? 0), 0.5)} (a compose count, not a wire count)`)
  }
  {
    const cols = 269
    console.log(`  ${cols}x70, truecolor ground, a streamed turn (the tail grows)`)
    const { frames, complete, reason, emission, writes } = await capture(cols, 70, 'paced')
    check('stream: the capture completed', complete, reason ?? '')
    check('stream: the fixture streamed the turn', emission !== null && emission.end - emission.start >= 3000, emission ? `${emission.end - emission.start} ms` : 'no emits')
    const window = emission === null ? null : { start: emission.start + 500, end: emission.end - 300 }
    const deliveries = window === null ? [] : writes.filter(w => w.ts >= window.start && w.ts <= window.end)
    const steady = window === null ? [] : frames.filter(r => (r.ts ?? 0) >= window.start && (r.ts ?? 0) <= window.end)
    check(`stream: enough frames while the tail was live (${steady.length} frames, ${deliveries.length} deliveries)`, steady.length >= 40 && deliveries.length >= 20)
    const cells = deliveries.map(w => wireCells(w.content))
    const clears = deliveries.reduce((n, w) => n + clearCount(w.content), 0)
    const wholeScreen = deliveries.filter(w => wireCells(w.content) >= (cols * 70) / 4)
    check(`stream: no publish repaints the screen (${clears} clears, ${wholeScreen.length} whole-screen runs)`, clears === 0 && wholeScreen.length === 0)
    check(`stream: a publish stays within the tail's rows — p50 ${pct(cells, 0.5)} cells, max ${Math.max(0, ...cells)} (cap 8 rows = ${8 * cols})`, pct(cells, 0.5) <= 2 * cols && Math.max(0, ...cells) <= 8 * cols)
  }
}

if (ONLY.has('4')) {
  section('§4 the real App: after every delivery the terminal equals the composed frame — a counter, jev open and its keys, the slot flipping jev → config → jev, /workbench, the help sheet')
  const { mock } = await import('bun:test')
  const childProcess = await import('node:child_process')
  const { KEY, mountOffscreen, pinScratchHome, releaseScratchHome, waitFor } = await import('../lib/settingsPopupHarness.ts')
  type Mounted = import('../lib/settingsPopupHarness.ts').Mounted
  const { settledFrame } = await import('../ui/popupFrameSettle.ts')
  const HOME_DIR = pinScratchHome('wire-census')
  for (const key of ['TYPESAFE_API_KEY', 'MERCURY_HOME', 'MERCURY_SEATS', 'MERCURY_CRITTER', 'MERCURY_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'HF_TOKEN', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'KIMI_API_KEY', 'NODE_ENV']) delete process.env[key]
  Object.assign(process.env, {
    MERCURY_FULLSCREEN: '1', MERCURY_HELM_HOME: '1', MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1', MERCURY_BOOT_PREFLIGHT: '0', MERCURY_REDUCED_MOTION: '1',
    MERCURY_LOCAL_PROBE_TARGETS: 'none', ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key', BROWSER: '/usr/bin/true', MERCURY_JEV_BASE: 'http://127.0.0.1:1',
  })
  for (const base of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_HUB_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_ZAI_API_BASE']) process.env[base] = 'http://127.0.0.1:1'
  mock.module('node:child_process', () => ({
    ...childProcess,
    execFile: (...args: unknown[]) => {
      const callback = args.find(a => typeof a === 'function') as ((error: Error | null, stdout: string, stderr: string) => void) | undefined
      setImmediate(() => callback?.(new Error('no subprocess in a proof'), '', ''))
      return { kill() {}, on() {}, unref() {} }
    },
  }))
  const React = await import('react')
  const h = React.createElement
  const { Box, Text } = await import('../../src/ink.ts')
  const { App } = await import('../../src/components/App.tsx')
  const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
  const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
  const { FullscreenLayout } = await import('../../src/components/FullscreenLayout.tsx')
  const { HelpV2 } = await import('../../src/components/HelpV2/HelpV2.tsx')
  const { default: PromptInput } = await import('../../src/components/PromptInput/PromptInput.tsx')
  const { resetChromeModeLatchForTests } = await import('../../src/hooks/useLayoutTier.ts')
  const { initializeSurfaceRoute, ROOT_CHAT_ROUTE } = await import('../../src/context/surfaceRoute.ts')
  const { enableConfigs, saveGlobalConfig, saveCurrentProjectConfig } = await import('../../src/utils/config.ts')
  const settings = await import('../../src/utils/cockpit/settingsPopup.ts')
  const jevCommand = await import('../../src/commands/jev/jev.tsx')
  const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.ts')
  enableConfigs()
  saveCurrentProjectConfig(c => ({ ...c, hasCompletedProjectOnboarding: true }))
  saveGlobalConfig(c => ({ ...c, prStatusFooterEnabled: false }))
  const context = { messages: [], options: {} } as never
  let setModal: (node: React.ReactNode) => void = () => {}
  let setCount: (n: number) => void = () => {}

  function Harness({ columns }: { columns: number }): React.ReactNode {
    const [modal, updateModal] = React.useState<React.ReactNode>(null)
    setModal = updateModal
    const [count, updateCount] = React.useState(0)
    setCount = updateCount
    const [vimMode, setVimMode] = React.useState<'INSERT' | 'NORMAL'>('INSERT')
    const [searching, setSearching] = React.useState(false)
    const [help, setHelp] = React.useState(false)
    const [bashes, setBashes] = React.useState<string | boolean>(false)
    const insertRef = React.useRef<unknown>(null)
    const modalScrollRef = React.useRef(null)
    return h(FullscreenLayout, {
      scrollable: h(Box, { flexDirection: 'column' }, ...Array.from({ length: 100 }, (_, key) => h(Text, { key, wrap: 'truncate-end' }, `transcript row ${key} · `.repeat(3)))),
      statusBand: h(Text, null, `thinking ${count}s`),
      statusBandActive: count > 0,
      modal: modal === null ? undefined : h(Box, { width: '100%', flexDirection: 'column' }, modal),
      modalScrollRef,
      bottom: h(PromptInput, {
        debug: false, toolPermissionContext: getDefaultAppState().toolPermissionContext,
        setToolPermissionContext: () => {}, apiKeyStatus: 'valid', commands: [], agents: [], isLoading: false,
        verbose: false, submitCount: 0, onShowMessageSelector: () => {}, mcpClients: [], vimMode, setVimMode,
        showBashesDialog: bashes, setShowBashesDialog: setBashes, onExit: () => {}, getToolUseContext: () => ({}),
        onSubmit: async () => {}, isSearchingHistory: searching, setIsSearchingHistory: setSearching,
        helpOpen: help, setHelpOpen: setHelp, hasSuppressedDialogs: false, isLocalJSXCommandActive: modal !== null,
        insertTextRef: insertRef,
      } as never),
    } as never)
  }
  const wrap = (node: React.ReactNode): React.ReactNode => h(App, { initialState: getDefaultAppState(), getFpsMetrics: () => undefined } as never, h(KeybindingSetup, null, node))

  type Composed = { f: number; rows: string[] }
  type Delivery = { ts?: number; content?: string; phase?: string; patches?: number }
  const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g
  const WIDTH_PROBE_WRITE = /\x1b7.*\x1b\[6n/s
  const tail = (path: string, offset: { at: number }): string[] => {
    if (!existsSync(path)) return []
    const bytes = readFileSync(path)
    if (bytes.length <= offset.at) return []
    const text = bytes.subarray(offset.at).toString('utf8')
    offset.at = bytes.length
    return text.split('\n').filter(Boolean)
  }
  const composedAt = { at: 0 }
  const writesAt = { at: 0 }
  tail(COMPOSED_TEE, composedAt)
  tail(process.env.INK_WRITE_TEE!, writesAt)
  type FrameRecord = { f: number; rows: string[]; delivered: boolean; shown: string[] }
  class Ledger {
    readonly emu: Emulator
    previous: string[] | null = null
    frames = 0
    deliveries = 0
    quiet = 0
    constructor(columns: number, rows: number) {
      this.emu = new AnsiEmulator(columns, rows, true)
    }
    settle(label: string, modalBoundary = false): FrameRecord[] {
      const composed = tail(COMPOSED_TEE, composedAt).map(l => JSON.parse(l) as Partial<Composed>).filter((r): r is Composed => typeof r.f === 'number' && Array.isArray(r.rows))
      const groups: Array<{ delivery: Delivery | null }> = []
      for (const line of tail(process.env.INK_WRITE_TEE!, writesAt)) {
        const record = JSON.parse(line) as Delivery
        if (record.phase === 'before-diff') groups.push({ delivery: null })
        else if (record.phase !== 'after-diff' && groups.length > 0) groups[groups.length - 1]!.delivery = record
      }
      check(`${label}: every composed frame has its delivery record (${composed.length} frames, ${groups.length} writer passes)`, composed.length === groups.length)
      const out: FrameRecord[] = []
      let firstFault = ''
      let silentChange = ''
      let clears = 0
      for (let k = 0; k < Math.min(composed.length, groups.length); k++) {
        const frame = composed[k]!
        const content = groups[k]!.delivery?.content ?? ''
        const delivered = content !== ''
        if (delivered && !WIDTH_PROBE_WRITE.test(content)) {
          this.emu.feed(content.replace(PROBE_CSI, ''))
          this.deliveries++
          if (this.frames > 0) clears += clearCount(content)
          if (process.env.WIRE_CENSUS_DEBUG && clearCount(content) > 0) console.log(`    · frame ${frame.f} cleared after ${this.quiet} diff-less frames: ${JSON.stringify(content.slice(0, 48))}`)
          this.quiet = 0
        } else this.quiet++
        this.frames++
        const rows = frame.rows.map(r => r.replace(/\s+$/, ''))
        const shown = this.emu.lines()
        if (process.env.WIRE_CENSUS_DEBUG) console.log(`    · frame ${frame.f} ${delivered ? `delivered ${content.length} bytes ${JSON.stringify(content.slice(0, 40))}` : 'no delivery'}; composed row 0 ${JSON.stringify(rows[0]?.slice(0, 40))}; terminal row 0 ${JSON.stringify(shown[0]?.slice(0, 40))}`)
        if (firstFault === '') {
          for (let y = 0; y < Math.max(rows.length, shown.length); y++) {
            if ((rows[y] ?? '') !== (shown[y] ?? '')) {
              firstFault = `frame ${frame.f} row ${y}: terminal ${JSON.stringify(shown[y] ?? '')} vs composed ${JSON.stringify(rows[y] ?? '')}`
              break
            }
          }
        }
        if (!delivered && this.previous !== null && silentChange === '' && rows.join('\n') !== this.previous.join('\n')) silentChange = `frame ${frame.f} changed its rows and delivered nothing`
        this.previous = rows
        out.push({ f: frame.f, rows, delivered, shown })
      }
      check(`${label}: the terminal equals the composed frame after every delivery (${out.length} frames, ${out.filter(r => r.delivered).length} delivered, ${clears} clears${modalBoundary ? ', the modal boundary may repaint' : ''})`, firstFault === '' && silentChange === '' && (modalBoundary || clears === 0), firstFault || silentChange || `clears=${clears}`)
      return out
    }
  }
  function firstEmission(label: string, frames: FrameRecord[], needle: string, also: (shown: string[]) => boolean = () => true): void {
    const first = frames.find(r => r.rows.some(row => row.includes(needle)))
    check(`${label}: the first frame composed with ${JSON.stringify(needle)} delivers it (frame ${first?.f ?? '—'})`, first !== undefined && first.delivered && first.shown.some(row => row.includes(needle)) && also(first.shown), first === undefined ? 'never composed' : first.shown.filter(l => l.trim()).slice(0, 5).join(' | '))
  }
  const bodyRows = (shown: string[], title: string): number => {
    const at = shown.findIndex(l => l.includes(title))
    return at < 0 ? 0 : shown.slice(at + 1).filter(l => /│\s*\S/.test(l) && !/^[\s│╭╮╰╯─]+$/.test(l)).length
  }
  async function changedAfter(scene: Mounted, before: string, send: string): Promise<boolean> {
    scene.push(send)
    return settledFrame(scene, frame => frame !== before).catch(() => false)
  }
  const configCommand = await import('../../src/commands/config/config.tsx')
  const workbenchCommand = await import('../../src/commands/workbench/workbench.tsx')

  for (const size of (arg('--sizes') ?? '178x51,120x44').split(',')) {
    const [columns, rows] = size.split('x').map(Number) as [number, number]
    console.log(`  ${size}`)
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    const ledger = new Ledger(columns, rows)
    const scene = await mountOffscreen(wrap(h(Harness, { columns })), columns, rows)
    await settledFrame(scene, frame => frame.includes('transcript row') && frame.includes('Type a prompt'))
    ledger.settle(`${size} settled chrome`)
    for (const n of [1, 2, 3]) {
      const before = scene.screen()
      setCount(n)
      const advanced = await settledFrame(scene, frame => frame.includes(`thinking ${n}s`) && frame !== before).catch(() => false)
      check(`${size} counter ${n}: the frame with the new digit painted`, advanced)
      firstEmission(`${size} counter ${n}`, ledger.settle(`${size} counter ${n}`), `thinking ${n}s`)
    }
    await jevCommand.call('', context)
    check(`${size} jev: the popup opened`, await settledFrame(scene, frame => frame.includes('Mercury · jev')).catch(() => false))
    firstEmission(`${size} jev open`, ledger.settle(`${size} jev open`), 'Mercury · jev', shown => bodyRows(shown, 'Mercury · jev') >= 3)
    for (const [name, key] of [['↵', KEY.enter], ['⌫', '\x7f'], ['→', KEY.right], ['← (the gutter proof\'s jev flip)', KEY.left]] as const) {
      const before = scene.screen()
      check(`${size} jev ${name}: the popup repainted`, await changedAfter(scene, before, key))
      if (process.env.WIRE_CENSUS_DEBUG) console.log(`    · after ${name}: ${scene.lines().filter(l => /Switch|JEV o/.test(l)).map(l => l.trim().slice(0, 120)).join(' || ')}`)
      ledger.settle(`${size} jev ${name}`)
    }
    await configCommand.call('', context)
    check(`${size} slot flip to config: the surface opened`, await settledFrame(scene, frame => frame.includes('Mercury · config') && !frame.includes('Mercury · jev')).catch(() => false))
    firstEmission(`${size} slot flip to config`, ledger.settle(`${size} slot flip to config`), 'Mercury · config', shown => bodyRows(shown, 'Mercury · config') >= 3)
    await jevCommand.call('', context)
    check(`${size} slot flip back to jev: the surface opened`, await settledFrame(scene, frame => frame.includes('Mercury · jev') && !frame.includes('Mercury · config')).catch(() => false))
    firstEmission(`${size} slot flip back to jev`, ledger.settle(`${size} slot flip back to jev`), 'Mercury · jev', shown => bodyRows(shown, 'Mercury · jev') >= 3)
    settings.closeSettingsPopup()
    check(`${size} jev closed`, await settledFrame(scene, frame => !frame.includes('Mercury · jev')).catch(() => false))
    ledger.settle(`${size} jev closed`)
    setModal(await workbenchCommand.call(() => setModal(null), context, ''))
    check(`${size} /workbench: the prompts panel opened`, await settledFrame(scene, frame => frame.includes('Mercury — prompts')).catch(() => false))
    firstEmission(`${size} /workbench`, ledger.settle(`${size} /workbench`, true), 'Mercury — prompts')
    setModal(null)
    check(`${size} /workbench closed`, await settledFrame(scene, frame => !frame.includes('Mercury — prompts') && frame.includes('Type a prompt')).catch(() => false))
    ledger.settle(`${size} /workbench closed`, true)
    scene.unmount()
    ledger.settle(`${size} unmount`)
    resetOverlayStackForTests()
    console.log(`    ${ledger.frames} frames, ${ledger.deliveries} deliveries`)
  }
  {
    initializeSurfaceRoute(ROOT_CHAT_ROUTE)
    resetChromeModeLatchForTests()
    const ledger = new Ledger(80, 24)
    const scene = await mountOffscreen(wrap(h(Harness, { columns: 80 })), 80, 24)
    await settledFrame(scene, frame => frame.includes('transcript row') && frame.includes('Type a prompt'))
    ledger.settle('80x24 settled chrome')
    setModal(h(HelpV2, { commands: [], onClose: () => setModal(null) }))
    check('80x24 help: the sheet opened', await settledFrame(scene, frame => frame.includes('Mercury — help')).catch(() => false))
    firstEmission('80x24 help sheet', ledger.settle('80x24 help sheet', true), 'Mercury — help')
    const before = scene.screen()
    setModal(null)
    check('80x24 help: the sheet closed', await settledFrame(scene, frame => !frame.includes('Mercury — help') && frame !== before).catch(() => false))
    ledger.settle('80x24 help closed', true)
    scene.unmount()
    ledger.settle('80x24 unmount')
    resetOverlayStackForTests()
    console.log(`    ${ledger.frames} frames, ${ledger.deliveries} deliveries`)
  }
  await releaseScratchHome(HOME_DIR)
}

if (failures > 0) {
  console.error(`\n❌ ${failures} of ${checks} WIRE-CENSUS CHECK(S) FAILED`)
  process.exit(1)
}
console.log(`\n✅ ALL ${checks} WIRE-CENSUS CHECKS PASS`)
