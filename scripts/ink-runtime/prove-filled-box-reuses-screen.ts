#!/usr/bin/env bun
// gate-watch: src/ink/cell-grid.ts src/ink/compose-buffer.ts src/ink/compose-walk.ts src/ink/dom.ts src/ink/renderer.ts
export {}
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendChildNode, createNode, createTextNode, insertBeforeNode, markDirty, removeChildNode, setAttribute, setTextNodeValue } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
const { CellWidth, cellAt } = await import('../../src/ink/cell-grid.js')
type Screen = import('../../src/ink/cell-grid.js').Screen
const { lastComposeCounts } = await import('../../src/ink/compose-buffer.js')
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { applySceneStyle, makeContext } = await import('./frameHarness.js')
type ComposeContext = import('./frameHarness.js').ComposeContext
type Styles = import('../../src/ink/styles.js').Styles

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function box(style: Styles, children: DOMElement[] = []): DOMElement {
  const el = createNode('ink-box')
  applySceneStyle(el, { flexDirection: 'column', flexGrow: 0, flexShrink: 0, ...style })
  for (const child of children) appendChildNode(el, child)
  return el
}
function text(words: string): DOMElement {
  const el = createNode('ink-text')
  appendChildNode(el, createTextNode(words) as never)
  return el
}
const retext = (el: DOMElement, words: string): void => setTextNodeValue(el.childNodes[0] as never, words)

const rowOf = (screen: Screen, y: number): string =>
  Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)?.char || ' ').join('').trimEnd()

function difference(live: Screen, fresh: Screen): string | null {
  if (live.width !== fresh.width || live.height !== fresh.height) {
    return `size ${live.width}x${live.height} vs ${fresh.width}x${fresh.height}`
  }
  let cells = 0
  let first = -1
  for (let at = 0; at < live.width * live.height * 2; at += 2) {
    if (live.cells[at] === fresh.cells[at] && live.cells[at + 1] === fresh.cells[at + 1]) continue
    cells++
    if (first < 0) first = at >> 1
  }
  if (first < 0) return null
  const y = Math.floor(first / live.width)
  return `${cells} cells differ, first in row ${y}: reused ${JSON.stringify(rowOf(live, y))} · fresh ${JSON.stringify(rowOf(fresh, y))}`
}

type World = { root: DOMElement; render: ReturnType<typeof createRenderer>; frames: [Frame, Frame] }
function paint(world: World, cols: number, rows: number, fromScratch: boolean, regionScroll = true): Screen {
  world.root.layoutNode!.calculateLayout(cols, rows)
  const [front, back] = world.frames
  const { frame } = world.render({
    frontFrame: front,
    backFrame: back,
    isTTY: true,
    terminalWidth: cols,
    terminalRows: rows,
    altScreen: true,
    prevFrameContaminated: fromScratch,
    regionScrollUsable: regionScroll,
  })
  world.frames = [frame, front]
  return frame.screen
}

console.log('§1 PC-07: at 269x70 with the estate ground on, a ticking header reuses clean rails, transcript and footer')
{
  const COLS = 269
  const ROWS = 70
  const GROUND = '#0d181b'
  const buildCockpit = (ctx: ComposeContext) => {
    const root = createNode('ink-root')
    applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
    const spinner = text('✹')
    const timer = text('(12s)')
    const band = box(
      { flexDirection: 'row', borderStyle: 'round', width: COLS - 56, height: 5, overflow: 'hidden' },
      [spinner, text(' Working on painter internals '), timer],
    )
    const lanes = box(
      { width: 28, overflow: 'hidden' },
      Array.from({ length: 24 }, (_, i) => text(`lane ${i} · steady`)),
    )
    const vitals = box(
      { width: 28, overflow: 'hidden' },
      Array.from({ length: 20 }, (_, i) => text(`vital ${i} · 0%`)),
    )
    const content = box(
      { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' },
      Array.from({ length: 90 }, (_, i) => text(`transcript row ${String(i).padStart(2, '0')} · ${'prose '.repeat(20)}`)),
    )
    const transcript = box(
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflowX: 'scroll', overflowY: 'scroll' },
      [content],
    )
    setAttribute(transcript, 'stickyScroll', true)
    const centre = box(
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', borderStyle: 'round' },
      [band, transcript],
    )
    const row = box(
      { flexDirection: 'row', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' },
      [lanes, centre, vitals],
    )
    const footer = box({ flexDirection: 'row', width: COLS, height: 3, borderStyle: 'round' }, [text('❯ Type a prompt')])
    const ground = box({ width: COLS, height: ROWS, overflow: 'hidden', backgroundColor: GROUND as never }, [row, footer])
    appendChildNode(root, ground)
    return {
      root,
      spinner,
      timer,
      ground,
      render: createRenderer(root, ctx.stylePool),
      frames: [
        emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
        emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      ] as [Frame, Frame],
    }
  }

  const ctx = makeContext()
  const live = buildCockpit(ctx)
  const fresh = buildCockpit(ctx)
  paint(live, COLS, ROWS, false)
  paint(fresh, COLS, ROWS, true)

  retext(live.spinner, '✺')
  retext(fresh.spinner, '✺')
  const ticked = paint(live, COLS, ROWS, false)
  const counts = { ...lastComposeCounts }
  const expected = paint(fresh, COLS, ROWS, true)
  const diff = difference(ticked, expected)

  check(
    '269x70 grounded spinner tick matches fresh paint cell-for-cell and style-for-style',
    diff === null,
    diff ?? '',
  )
  check(
    '269x70 grounded spinner tick blits the clean panes (>= 15,000 blitted cells) and writes < 1,200 cells (was 29,426)',
    counts.blit >= 15_000 && counts.write < 1_200,
    JSON.stringify(counts),
  )

  const pillText = text('[ 1 new message · alt+↓ ]')
  const jumpPill = box(
    { position: 'absolute', left: 29, top: 65, width: COLS - 58, height: 1, justifyContent: 'center' },
    [box({ backgroundColor: '#201810' as never }, [pillText])],
  )
  const freshPillText = text('[ 1 new message · alt+↓ ]')
  const freshJumpPill = box(
    { position: 'absolute', left: 29, top: 65, width: COLS - 58, height: 1, justifyContent: 'center' },
    [box({ backgroundColor: '#201810' as never }, [freshPillText])],
  )
  appendChildNode(live.ground, jumpPill)
  appendChildNode(fresh.ground, freshJumpPill)
  paint(live, COLS, ROWS, false)
  paint(fresh, COLS, ROWS, true)

  retext(pillText, '[ 2 new messages · alt+↓ ]')
  retext(freshPillText, '[ 2 new messages · alt+↓ ]')
  const pillTicked = paint(live, COLS, ROWS, false)
  const pillCounts = { ...lastComposeCounts }
  const pillDiff = difference(pillTicked, paint(fresh, COLS, ROWS, true))
  check(
    '269x70 see-through JumpPill update invalidates only its 1-row band, blitting >= 15,000 clean cells with < 900 write cells',
    pillDiff === null && pillCounts.blit >= 15_000 && pillCounts.write < 900,
    JSON.stringify({ pillDiff, pillCounts }),
  )
}

console.log('\n§2 Ground colour transitions, opaque toggles, row samplers, and wide-glyph sub-region fills')
{
  const COLS = 36
  const ROWS = 8
  const ctx = makeContext()
  const makeScene = (bg: string | undefined) => {
    const root = createNode('ink-root')
    applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
    const kept = box({ width: COLS, height: 3, overflow: 'hidden' }, [text('漢字漢字漢字漢字漢字漢字'), text('steady second line')])
    const inner = box({ width: 14, height: 2, backgroundColor: '#3a2a10' as never }, [text('inner badge')])
    const ground = box({ width: COLS, height: ROWS, ...(bg ? { backgroundColor: bg as never } : {}) }, [kept, inner])
    appendChildNode(root, ground)
    return {
      root,
      kept,
      inner,
      ground,
      render: createRenderer(root, ctx.stylePool),
      frames: [
        emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
        emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      ] as [Frame, Frame],
    }
  }

  const live = makeScene('#0d181b')
  paint(live, COLS, ROWS, false)

  for (const nextBg of ['#201810', undefined, '#0d181b'] as const) {
    applySceneStyle(live.ground, { width: COLS, height: ROWS, ...(nextBg ? { backgroundColor: nextBg as never } : {}) })
    const actual = paint(live, COLS, ROWS, false)
    const expected = paint(makeScene(nextBg), COLS, ROWS, true)
    const diff = difference(actual, expected)
    check(`ground transition -> ${nextBg ?? 'none'} repaints clean children onto the new ground`, diff === null, diff ?? '')
  }

  const wideCtx = makeContext()
  const makeWideOverlay = () => {
    const root = createNode('ink-root')
    applySceneStyle(root, { width: 20, height: 4, flexDirection: 'column' })
    const base = text('漢字漢字漢字漢字漢字')
    const badge = box({ position: 'absolute', left: 1, top: 0, width: 4, height: 1, backgroundColor: '#201810' as never }, [text('ab')])
    const ground = box({ width: 20, height: 4, backgroundColor: '#0d181b' as never }, [base, badge])
    appendChildNode(root, ground)
    return {
      root,
      render: createRenderer(root, wideCtx.stylePool),
      frames: [
        emptyFrame(4, 20, wideCtx.stylePool, wideCtx.charPool, wideCtx.hyperlinkPool),
        emptyFrame(4, 20, wideCtx.stylePool, wideCtx.charPool, wideCtx.hyperlinkPool),
      ] as [Frame, Frame],
    }
  }
  const wideScreen = paint(makeWideOverlay(), 20, 4, false)
  check(
    'a sub-row typed fill splitting wide CJK glyphs on both edges mends the split halves to narrow blanks',
    cellAt(wideScreen, 0, 0)?.width === CellWidth.Narrow &&
      cellAt(wideScreen, 0, 0)?.char === ' ' &&
      cellAt(wideScreen, 5, 0)?.width === CellWidth.Narrow &&
      cellAt(wideScreen, 5, 0)?.char === ' ',
    JSON.stringify([cellAt(wideScreen, 0, 0), cellAt(wideScreen, 5, 0)]),
  )

  const popCtx = makeContext()
  const makeAbsGroundedPopup = () => {
    const root = createNode('ink-root')
    applySceneStyle(root, { width: 40, height: 10, flexDirection: 'column' })
    const keptTitle = text('popup line one')
    const editedLine = text('popup line two')
    const popup = box(
      { position: 'absolute', left: 4, top: 2, width: 26, height: 5, borderStyle: 'round', backgroundColor: '#3a2a10' as never },
      [keptTitle, editedLine],
    )
    const ground = box({ width: 40, height: 10, backgroundColor: '#0d181b' as never }, [text('backdrop'), popup])
    appendChildNode(root, ground)
    return {
      root,
      editedLine,
      render: createRenderer(root, popCtx.stylePool),
      frames: [
        emptyFrame(10, 40, popCtx.stylePool, popCtx.charPool, popCtx.hyperlinkPool),
        emptyFrame(10, 40, popCtx.stylePool, popCtx.charPool, popCtx.hyperlinkPool),
      ] as [Frame, Frame],
    }
  }
  const livePop = makeAbsGroundedPopup()
  const freshPop = makeAbsGroundedPopup()
  paint(livePop, 40, 10, false)
  paint(freshPop, 40, 10, true)
  retext(livePop.editedLine, 'popup line changed')
  retext(freshPop.editedLine, 'popup line changed')
  const popDiff = difference(paint(livePop, 40, 10, false), paint(freshPop, 40, 10, true))
  check('editing one child inside a grounded absolute popup preserves clean sibling children inside that popup', popDiff === null, popDiff ?? '')
}

console.log('\n§3 Seeded differential walks UNDER THE ESTATE GROUND (CHROME + CARD + PANE + OVERLAY, 3 shapes × 24 seeds × 120 steps)')
{
  const COLOURS = ['#101820', '#201810', '#3a2a10', '#102a3a', 'rgb(13,24,27)']
  const WORDS = ['steady', 'prose', 'that', 'stays', '漢字', 'wide', 'a', 'tail', 'line', 'of', 'the', 'reply', 'ok', '✓', 'grows', 'x']
  type Item = { el: DOMElement; text: DOMElement; bubble: boolean }
  type Popup = { outer: DOMElement; inner: DOMElement; body: DOMElement }
  type Tree = World & {
    ground: DOMElement
    capsule: DOMElement
    rail: DOMElement
    railLines: DOMElement[]
    spinner: DOMElement
    label: DOMElement
    timer: DOMElement
    transcript: DOMElement
    content: DOMElement
    items: Item[]
    footer: DOMElement
    footerRow: DOMElement
    card: { host: DOMElement; card: DOMElement; answer: DOMElement } | null
    popup: Popup | null
  }
  type Shape = { name: string; cols: number; rows: number; withRail: boolean; regionScroll: boolean; paddingTop: number }
  type Model = { items: number; bubbles: boolean[]; railShown: boolean; border: boolean; card: boolean; popup: boolean }
  type Step = { kind: string; say: string; apply: (tree: Tree, shape: Shape) => void }

  function prng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const makeItem = (words: string, bubble: string | undefined): Item => {
    const line = text(words)
    return bubble === undefined
      ? { el: line, text: line, bubble: false }
      : { el: box({ backgroundColor: bubble as never, paddingLeft: 1, paddingRight: 1, flexDirection: 'row' }, [line]), text: line, bubble: true }
  }
  const build = (ctx: ComposeContext, shape: Shape): Tree => {
    const { cols, rows } = shape
    const root = createNode('ink-root')
    applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
    const spinner = text('✹')
    const label = text('Molting…')
    const timer = text('(1s)')
    const capsule = box({ flexDirection: 'row', borderStyle: 'round', flexGrow: 1 }, [spinner, text(' '), label, text(' '), timer])
    const band = box({ flexDirection: 'row', borderStyle: 'round', width: shape.withRail ? cols - 14 : cols, overflow: 'hidden' }, [box({ width: 7 }, [text(' ▄▄▄ \n █▀█ \n ▀▀▀ ')]), capsule])
    const railLines = [text('lanes'), text('❯ WORKBENCH'), text('  hello'), text('  files')]
    const rail = box({ width: 14, overflow: 'hidden' }, railLines)
    const items = Array.from({ length: rows + 12 }, (_, i) => makeItem(`line ${String(i).padStart(2, '0')} · steady prose that stays`, i % 9 === 4 ? COLOURS[2] : undefined))
    const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }, items.map(entry => entry.el))
    const transcript = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflowX: 'scroll', overflowY: 'scroll', paddingTop: shape.paddingTop }, [content])
    setAttribute(transcript, 'stickyScroll', true)
    const centre = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }, [band, transcript])
    const row = box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' }, shape.withRail ? [rail, centre] : [centre])
    const footer = text('Type a prompt')
    const footerRow = box({ flexDirection: 'row', width: cols }, [footer])
    const groundBox = box({ width: cols, height: rows, overflow: 'hidden', backgroundColor: '#101820' as never }, [row, footerRow])
    appendChildNode(root, groundBox)
    return { root, render: createRenderer(root, ctx.stylePool), frames: [emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)], ground: groundBox, capsule, rail, railLines, spinner, label, timer, transcript, content, items, footer, footerRow, card: null, popup: null }
  }

  const KINDS = ['rest', 'spinner', 'label', 'timer', 'rail-line', 'footer', 'border', 'rail-toggle', 'card-open', 'card-answer', 'card-margin', 'card-close', 'popup-open', 'popup-text', 'popup-move', 'popup-close', 'item-text', 'item-lines', 'append', 'remove', 'insert', 'scroll', 'scroll-end', 'bubble-colour']
  const WEIGHTS: Record<string, number> = { rest: 4, spinner: 10, label: 6, timer: 6, 'rail-line': 4, footer: 3, border: 2, 'rail-toggle': 2, 'card-open': 3, 'card-answer': 4, 'card-margin': 2, 'card-close': 2, 'popup-open': 3, 'popup-text': 5, 'popup-move': 3, 'popup-close': 2, 'item-text': 8, 'item-lines': 4, append: 6, remove: 3, insert: 3, scroll: 8, 'scroll-end': 2, 'bubble-colour': 3 }

  function next(rand: () => number, model: Model, shape: Shape): Step {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
    const words = (n: number): string => Array.from({ length: n }, () => pick(WORDS)).join(' ')
    const usable = KINDS.filter(k =>
      (k !== 'rail-line' && k !== 'rail-toggle' || shape.withRail) &&
      (k !== 'remove' || model.items > 8) &&
      (k !== 'card-open' || !model.card) &&
      (!['card-answer', 'card-margin', 'card-close'].includes(k) || model.card) &&
      (k !== 'popup-open' || !model.popup) &&
      (!['popup-text', 'popup-move', 'popup-close'].includes(k) || model.popup),
    )
    let roll = rand() * usable.reduce((n, k) => n + WEIGHTS[k]!, 0)
    let kind = usable[0]!
    for (const candidate of usable) {
      if (roll < WEIGHTS[candidate]!) { kind = candidate; break }
      roll -= WEIGHTS[candidate]!
    }
    switch (kind) {
      case 'spinner': { const g = pick(['✹', '✺', '✶', '·']); return { kind, say: `spinner ${g}`, apply: t => retext(t.spinner, g) } }
      case 'label': { const s = `${words(int(1, 3))}…`; return { kind, say: `label`, apply: t => retext(t.label, s) } }
      case 'timer': { const s = `(${int(1, 120)}s)`; return { kind, say: `timer`, apply: t => retext(t.timer, s) } }
      case 'rail-line': { const at = int(0, 3); const s = words(int(0, 2)); return { kind, say: `rail ${at}`, apply: t => retext(t.railLines[at]!, s) } }
      case 'footer': { const s = words(int(1, 6)); return { kind, say: `footer`, apply: t => retext(t.footer, s) } }
      case 'border': { model.border = !model.border; const on = model.border; return { kind, say: `border ${on}`, apply: t => applySceneStyle(t.capsule, on ? { flexDirection: 'row', borderStyle: 'round', flexGrow: 1 } : { flexDirection: 'row', flexGrow: 1 }) } }
      case 'rail-toggle': { model.railShown = !model.railShown; const on = model.railShown; return { kind, say: `rail ${on}`, apply: t => applySceneStyle(t.rail, { width: 14, overflow: 'hidden', display: on ? 'flex' : 'none' }) } }
      case 'item-text': { const at = int(0, model.items - 1); const s = words(int(0, 9)); return { kind, say: `item ${at}`, apply: t => retext(t.items[at]!.text, s) } }
      case 'item-lines': { const at = int(Math.max(0, model.items - 6), model.items - 1); const s = Array.from({ length: int(1, 4) }, () => words(int(1, 5))).join('\n'); return { kind, say: `item-lines ${at}`, apply: t => retext(t.items[at]!.text, s) } }
      case 'append': { const s = words(int(1, 8)); const b = rand() < 0.2 ? pick(COLOURS) : undefined; model.items++; model.bubbles.push(b !== undefined); return { kind, say: `append`, apply: t => { const e = makeItem(s, b); t.items.push(e); appendChildNode(t.content, e.el) } } }
      case 'remove': { const at = int(0, model.items - 1); model.items--; model.bubbles.splice(at, 1); return { kind, say: `remove ${at}`, apply: t => removeChildNode(t.content, t.items.splice(at, 1)[0]!.el) } }
      case 'insert': { const at = int(0, model.items - 1); const s = words(int(1, 8)); model.items++; model.bubbles.splice(at, 0, false); return { kind, say: `insert ${at}`, apply: t => { const e = makeItem(s, undefined); insertBeforeNode(t.content, e.el, t.items[at]!.el); t.items.splice(at, 0, e) } } }
      case 'scroll': { const d = pick([-1, -1, -2, -3, -5, -9, 1, 1, 2, 3, 5, 9, -40]); return { kind, say: `scroll ${d}`, apply: t => { const sc = (t.transcript.scroll ??= {}); sc.pendingScrollDelta = (sc.pendingScrollDelta ?? 0) + d; sc.stickyScroll = false; markDirty(t.transcript) } } }
      case 'scroll-end': return { kind, say: 'scroll-end', apply: t => { (t.transcript.scroll ??= {}).pendingScrollDelta = 9999; markDirty(t.transcript) } }
      case 'bubble-colour': { const held = model.bubbles.map((b, at) => (b ? at : -1)).filter(at => at >= 0); if (held.length === 0) return { kind: 'rest', say: 'rest', apply: () => {} }; const at = pick(held); const c = rand() < 0.3 ? undefined : pick(COLOURS); return { kind, say: `bubble ${at}`, apply: t => applySceneStyle(t.items[at]!.el, { ...(c ? { backgroundColor: c as never } : {}), paddingLeft: 1, paddingRight: 1, flexDirection: 'row' }) } }
      case 'card-open': { model.card = true; const m = pick([-1, -1, -2, 0]); const w = rand() < 0.5; return { kind, say: `card-open ${m}`, apply: (t, s) => { const ans = text('1. Redis'); const card = box({ marginTop: m, width: s.cols }, [text(w ? '─'.repeat(s.cols) : '── a question'), ans]); const host = box({ width: s.cols }, [card]); t.card = { host, card, answer: ans }; insertBeforeNode(t.ground, host, t.footerRow) } } }
      case 'card-answer': { const s = `${int(1, 4)}. ${words(int(1, 3))}`; return { kind, say: `card-answer`, apply: t => retext(t.card!.answer, s) } }
      case 'card-margin': { const m = pick([-2, -1, 0]); return { kind, say: `card-margin ${m}`, apply: (t, s) => applySceneStyle(t.card!.card, { marginTop: m, width: s.cols }) } }
      case 'card-close': { model.card = false; return { kind, say: 'card-close', apply: t => { removeChildNode(t.ground, t.card!.host); t.card = null } } }
      case 'popup-open': {
        model.popup = true
        const floating = rand() < 0.5
        return {
          kind,
          say: `popup-open floating=${floating}`,
          apply: (t, s) => {
            const body = text('opt 1\nopt 2\nopt 3')
            const inner = box({ width: 28, borderStyle: 'round', opaque: true, backgroundColor: '#201810' as never }, [body])
            const outer = floating
              ? box({ position: 'absolute', left: 8, top: 0, width: 28, height: s.rows, justifyContent: 'center' }, [inner])
              : box({ position: 'absolute', left: 8, top: 3, width: 28, borderStyle: 'round', opaque: true, overflow: 'hidden', backgroundColor: '#201810' as never }, [body])
            t.popup = { outer, inner, body }
            appendChildNode(t.ground, outer)
          },
        }
      }
      case 'popup-text': {
        const lines = Array.from({ length: int(1, 5) }, (_, k) => `opt ${k} ${words(int(1, 2))}`).join('\n')
        return { kind, say: 'popup-text', apply: t => retext(t.popup!.body, lines) }
      }
      case 'popup-move': {
        const left = int(4, 18)
        const top = int(1, 6)
        return { kind, say: `popup-move ${left},${top}`, apply: t => applySceneStyle(t.popup!.outer, { ...t.popup!.outer.style, left, top }) }
      }
      case 'popup-close': {
        model.popup = false
        return { kind, say: 'popup-close', apply: t => { removeChildNode(t.ground, t.popup!.outer); t.popup = null } }
      }
    }
    return { kind: 'rest', say: 'rest', apply: () => {} }
  }

  const SHAPES: Shape[] = [
    { name: '96x24 with rail', cols: 96, rows: 24, withRail: true, regionScroll: false, paddingTop: 1 },
    { name: '120x44 full width', cols: 120, rows: 44, withRail: false, regionScroll: true, paddingTop: 0 },
    { name: '80x20 with rail+region', cols: 80, rows: 20, withRail: true, regionScroll: true, paddingTop: 1 },
  ]
  for (const shape of SHAPES) {
    const wrong: string[] = []
    let blittedFrames = 0
    for (let seed = 1; seed <= 24; seed++) {
      const rand = prng(seed * 7919 + shape.cols)
      const ctx = makeContext()
      const live = build(ctx, shape)
      const fresh = build(ctx, shape)
      const model: Model = { items: live.items.length, bubbles: live.items.map(e => e.bubble), railShown: true, border: true, card: false, popup: false }
      paint(live, shape.cols, shape.rows, false, shape.regionScroll)
      paint(fresh, shape.cols, shape.rows, true, shape.regionScroll)
      for (let step = 0; step < 120; step++) {
        const move = next(rand, model, shape)
        if (live.transcript.scroll) fresh.transcript.scroll = { ...live.transcript.scroll }
        move.apply(live, shape)
        move.apply(fresh, shape)
        const reused = paint(live, shape.cols, shape.rows, false, shape.regionScroll)
        if (lastComposeCounts.blit > 0) blittedFrames++
        const diff = difference(reused, paint(fresh, shape.cols, shape.rows, true, shape.regionScroll))
        if (diff !== null) {
          wrong.push(`seed=${seed} step=${step} (${move.say}): ${diff}`)
          break
        }
      }
    }
    check(`${shape.name} under ground: all 24 walks × 120 steps equal fresh paint and engage blits (${blittedFrames} blitted frames)`, wrong.length === 0 && blittedFrames > 1000, wrong[0] ?? `blitted=${blittedFrames}`)
  }
}

console.log('\n§4 Text painting beyond its layout rect (reach): grounded, ungrounded, opaque, row-sampled, nested, scrolled, dirty/clean, and over a sibling')
{
  const styledText = (words: string, style: Styles = {}): DOMElement => {
    const el = createNode('ink-text')
    applySceneStyle(el, { flexGrow: 0, flexShrink: 1, flexDirection: 'row', textWrap: 'wrap', ...style })
    appendChildNode(el, createTextNode(words) as never)
    return el
  }

  const runPair = (
    cols: number,
    rows: number,
    make: (ctx: ComposeContext) => World & { steps: Array<() => void> },
  ): string | null => {
    const ctx = makeContext()
    const live = make(ctx)
    const fresh = make(ctx)
    paint(live, cols, rows, false)
    paint(fresh, cols, rows, true)
    for (let i = 0; i < live.steps.length; i++) {
      live.steps[i]!()
      fresh.steps[i]!()
      const a = paint(live, cols, rows, false)
      const b = paint(fresh, cols, rows, true)
      const diff = difference(a, b)
      if (diff !== null) return `step ${i + 1}: ${diff}`
    }
    return null
  }

  {
    const err = runPair(20, 5, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 20, height: 5, flexDirection: 'column' })
      const counter = styledText('tick 0')
      const ground = box(
        { width: 20, height: 5, flexDirection: 'column', backgroundColor: '#102030' as never },
        [
          box({ flexDirection: 'row', height: 1 }, [styledText('status words that wrap past the width')]),
          box({ marginTop: 2 }, [counter]),
        ],
      )
      appendChildNode(root, ground)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(5, 20, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(5, 20, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(counter, 'tick 1'), () => retext(counter, 'tick 2')],
      }
    })
    check('grounded root + 1-row box holding 2-line wrapped text keeps line 2 when a sibling ticks', err === null, err ?? '')
  }

  {
    const err = runPair(30, 8, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 30, height: 8, flexDirection: 'column' })
      const counter = styledText('tick 0')
      const host = box(
        { width: 30, height: 8, flexDirection: 'column' },
        [
          box({ flexDirection: 'column', height: 2 }, [styledText('one\ntwo\nthree\nfour')]),
          box({ marginTop: 4 }, [counter]),
        ],
      )
      appendChildNode(root, host)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(8, 30, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(8, 30, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(counter, 'tick 1'), () => retext(counter, 'tick 2')],
      }
    })
    check('ungrounded root + 2-row box holding shrinking 4-line text keeps lines 3 and 4 when a sibling ticks', err === null, err ?? '')
  }

  {
    const err = runPair(30, 8, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 30, height: 8, flexDirection: 'column' })
      const counter = styledText('tick 0')
      const host = box(
        { width: 30, height: 8, flexDirection: 'column' },
        [
          box(
            { flexDirection: 'column', opaque: true, height: 7 },
            [
              box({ flexDirection: 'column', height: 2 }, [styledText('one\ntwo\nthree\nfour')]),
              box({ marginTop: 3 }, [counter]),
            ],
          ),
        ],
      )
      appendChildNode(root, host)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(8, 30, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(8, 30, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(counter, 'tick 1')],
      }
    })
    check('opaque parent (no colour) + 2-row box holding shrinking 4-line text keeps lines 3 and 4', err === null, err ?? '')
  }

  {
    const err = runPair(22, 6, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 22, height: 6, flexDirection: 'column' })
      const counter = styledText('tick 0')
      const sampler = (r: number) => (r % 2 === 0 ? '#102030' : '#201810') as never
      const host = box(
        { width: 22, height: 6, flexDirection: 'column', fillRowBg: sampler },
        [
          box({ flexDirection: 'row', height: 1 }, [styledText('row sampled words wrapping below')]),
          box({ marginTop: 2 }, [counter]),
        ],
      )
      appendChildNode(root, host)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(6, 22, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(6, 22, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(counter, 'tick 1')],
      }
    })
    check('row-sampler parent (fillRowBg) + 1-row box holding wrapping text keeps all lines grounded', err === null, err ?? '')
  }

  {
    const err = runPair(20, 7, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 20, height: 7, flexDirection: 'column' })
      const innerTick = styledText('in 0')
      const outerTick = styledText('out 0')
      const ground = box(
        { width: 20, height: 7, flexDirection: 'column', backgroundColor: '#102030' as never },
        [
          box(
            { flexDirection: 'column', height: 4 },
            [
              box({ flexDirection: 'column', height: 2 }, [
                box({ flexDirection: 'row', height: 1 }, [styledText('deep words wrapping across three short rows here')]),
              ]),
              box({ marginTop: 1 }, [innerTick]),
            ],
          ),
          box({ marginTop: 1 }, [outerTick]),
        ],
      )
      appendChildNode(root, ground)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(7, 20, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(7, 20, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(outerTick, 'out 1'), () => retext(innerTick, 'in 1')],
      }
    })
    check('two boxes deep under ground: overflowing text survives both outer and inner sibling ticks', err === null, err ?? '')
  }

  {
    const err = runPair(24, 6, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 24, height: 6, flexDirection: 'column' })
      const itemTick = styledText('tail 0')
      const content = box(
        { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: 24 },
        [
          box({ flexDirection: 'row', height: 1 }, [styledText('scroll item words wrapping onto next row')]),
          box({ height: 1 }, [styledText('')]),
          box({ height: 1 }, [styledText('item two')]),
          box({ height: 1 }, [styledText('item three')]),
          box({ height: 1 }, [styledText('item four')]),
          box({ height: 1 }, [styledText('item five')]),
          box({ height: 1 }, [itemTick]),
        ],
      )
      const scroller = box(
        { flexDirection: 'column', width: 24, height: 5, overflowX: 'scroll', overflowY: 'scroll' },
        [content],
      )
      const outsideTick = styledText('bar 0')
      const ground = box({ width: 24, height: 6, flexDirection: 'column', backgroundColor: '#102030' as never }, [scroller, outsideTick])
      appendChildNode(root, ground)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(6, 24, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(6, 24, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [
          () => retext(outsideTick, 'bar 1'),
          () => retext(itemTick, 'tail 1'),
          () => {
            ;(scroller.scroll ??= {}).pendingScrollDelta = 1
            markDirty(scroller)
          },
          () => {
            ;(scroller.scroll ??= {}).pendingScrollDelta = -1
            markDirty(scroller)
          },
        ],
      }
    })
    check('inside a scroll box: overflowing text equals fresh paint across outside ticks, inner ticks, and scrolls', err === null, err ?? '')
  }

  {
    const err = runPair(20, 5, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 20, height: 5, flexDirection: 'column' })
      const over = styledText('first line here\noverflow tail words')
      const overHolder = box({ flexDirection: 'row', height: 1 }, [over])
      const sib = styledText('sib1')
      const sibHolder = box({ flexDirection: 'row', height: 1 }, [sib])
      const tick = styledText('t0')
      const ground = box({ width: 20, height: 5, flexDirection: 'column', backgroundColor: '#102030' as never }, [overHolder, sibHolder, tick])
      appendChildNode(root, ground)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(5, 20, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(5, 20, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [
          () => retext(tick, 't1'),
          () => retext(sib, 's'),
          () => retext(over, 'short'),
          () => retext(over, 'first line here\noverflow tail back'),
          () => removeChildNode(ground, overHolder),
        ],
      }
    })
    check('overflow landing on a sibling row holds when clean, when sibling shrinks, when overflow shrinks/grows, and on removal', err === null, err ?? '')
  }

  {
    const err = runPair(36, 8, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 36, height: 8, flexDirection: 'column' })
      const railMeter = styledText('▸ 5h 12% · 4h')
      const outsidePrompt = styledText('❯')
      const vitalsRail = box(
        { width: 16, height: 6, flexDirection: 'column', overflow: 'hidden' },
        [
          box({ flexDirection: 'row', width: 14, height: 1 }, [styledText('fixed vitals row wrapping onto two lines')]),
          box({ marginTop: 2, width: 14 }, [railMeter]),
        ],
      )
      const ground = box(
        { width: 36, height: 8, flexDirection: 'column', backgroundColor: '#0d181b' as never },
        [vitalsRail, box({ flexDirection: 'row' }, [outsidePrompt, styledText(' Type a prompt')])],
      )
      appendChildNode(root, ground)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(8, 36, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(8, 36, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(outsidePrompt, '›'), () => retext(railMeter, '▸ 5h 13% · 4h')],
      }
    })
    check('product shape (HelmVitalsRail fixed height=1 row): wrapping text inside a clipped rail holds across outside and rail ticks', err === null, err ?? '')
  }

  {
    const err = runPair(28, 6, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 28, height: 6, flexDirection: 'column' })
      const tailTick = styledText('turn 0')
      const messageResponse = box(
        { flexDirection: 'row', height: 1, overflowY: 'hidden', width: 28 },
        [
          box({ flexShrink: 0, flexDirection: 'row' }, [styledText('  ⎿  ')]),
          styledText('Running in the background (↓ to manage)'),
        ],
      )
      const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: 28 }, [messageResponse, tailTick])
      const scroller = box({ flexDirection: 'column', width: 28, height: 5, overflowX: 'scroll', overflowY: 'scroll' }, [content])
      const barTick = styledText('ready 0')
      const ground = box({ width: 28, height: 6, flexDirection: 'column', backgroundColor: '#0d181b' as never }, [scroller, barTick])
      appendChildNode(root, ground)
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(6, 28, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(6, 28, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [() => retext(barTick, 'ready 1'), () => retext(tailTick, 'turn 1')],
      }
    })
    check('product shape (MessageResponse height=1 overflowY=hidden in BashTool): clipped wrapping text equals fresh paint', err === null, err ?? '')
  }

  {
    const err = runPair(36, 10, ctx => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: 36, height: 10, flexDirection: 'column' })
      const rail = box({ width: 12, overflow: 'hidden' }, Array.from({ length: 8 }, (_, i) => box({ flexDirection: 'row', height: 1 }, [styledText(`rail row ${i}`)])))
      const centre = box({ flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', borderStyle: 'round' }, [styledText('centre pane')])
      const upper = box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' }, [rail, centre])
      const cardStyle = (rows: number): Styles => ({ flexDirection: 'column', flexGrow: 0, flexShrink: 0, width: 36, height: rows, borderStyle: 'round' })
      const card = box(cardStyle(3), [styledText('the card that takes the rows')])
      const ground = box({ width: 36, height: 10, overflow: 'hidden', backgroundColor: '#0d181b' as never }, [upper, card])
      appendChildNode(root, ground)
      const resize = (rows: number) => (): void => {
        applySceneStyle(card, cardStyle(rows))
        markDirty(card)
      }
      return {
        root,
        render: createRenderer(root, ctx.stylePool),
        frames: [emptyFrame(10, 36, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(10, 36, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)],
        steps: [resize(7), resize(6), resize(5), resize(4), resize(3), resize(8), resize(3)],
      }
    })
    check('product shape (the cockpit rails above a card that takes rows and gives them back): each row a clipped rail regains equals fresh paint, never the card that stood there', err === null, err ?? '')
  }
}

console.log(`\nprove-filled-box-reuses-screen: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
