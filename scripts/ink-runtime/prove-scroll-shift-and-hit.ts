#!/usr/bin/env bun
// gate-watch: src/ink/compose-walk.ts src/ink/geometry/hit.ts src/ink/node-cache.ts src/ink/renderer.ts
export {}
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendChildNode, createNode, createTextNode, insertBeforeNode, markDirty, removeChildNode, setAttribute, setTextNodeValue } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
type TextNode = import('../../src/ink/dom.js').TextNode
const { cellAt } = await import('../../src/ink/cell-grid.js')
type Screen = import('../../src/ink/cell-grid.js').Screen
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
const { dispatchClick, hitTest } = await import('../../src/ink/geometry/hit.js')
const { nodeCache } = await import('../../src/ink/node-cache.js')
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { applySceneStyle, buildDom, makeContext } = await import('./frameHarness.js')
type ComposeContext = import('./frameHarness.js').ComposeContext
type Styles = import('../../src/ink/styles.js').Styles

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

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

function makeScrollWorld(ctx: ComposeContext, cols: number, rows: number, regionScroll: boolean) {
  const root = createNode('ink-root')
  applySceneStyle(root, { flexDirection: 'column', width: cols, height: rows })
  const items: DOMElement[] = []
  const clicked: Array<{ id: string; localRow: number }> = []
  const content = buildDom({ kind: 'box', style: { flexDirection: 'column', width: cols, flexShrink: 0 } })
  for (let i = 0; i < 20; i++) {
    const badge = buildDom({ kind: 'box', style: { width: 12 }, children: [{ kind: 'text', text: `item ${String(i).padStart(2, '0')}` }] })
    setAttribute(badge, 'data-badge', `badge-${i}`)
    const el = buildDom({ kind: 'box', style: { flexDirection: 'row', width: cols } })
    const id = `item-${i}`
    setAttribute(el, 'data-id', id)
    el._eventHandlers = {
      onClick: (ev: { localRow: number }) => {
        clicked.push({ id, localRow: ev.localRow })
      },
    }
    appendChildNode(el, badge)
    items.push(el)
    appendChildNode(content, el)
  }
  const scroll = buildDom({
    kind: 'box',
    style: { flexDirection: 'column', width: cols, height: rows, overflowX: 'scroll', overflowY: 'scroll' },
  })
  setAttribute(scroll, 'stickyScroll', true)
  appendChildNode(scroll, content)
  appendChildNode(root, scroll)
  const render = createRenderer(root, ctx.stylePool)
  let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  return {
    root,
    scroll,
    content,
    items,
    clicked,
    paint(scratch: boolean) {
      root.layoutNode!.calculateLayout(cols, rows)
      const res = render({
        frontFrame: front,
        backFrame: back,
        isTTY: true,
        terminalWidth: cols,
        terminalRows: rows,
        altScreen: true,
        prevFrameContaminated: scratch,
        regionScrollUsable: regionScroll,
      })
      back = front
      front = res.frame
      return res
    },
  }
}

console.log('§1 PC-32: cached rects of children and descendants ride both region-scroll and rect shifts')
for (const regionScroll of [true, false]) {
  const ctx = makeContext()
  const w = makeScrollWorld(ctx, 40, 10, regionScroll)
  w.paint(false)
  ;(w.scroll.scroll ??= {}).pendingScrollDelta = -3
  w.scroll.scroll.stickyScroll = false
  markDirty(w.scroll)
  const afterUp = w.paint(false)
  const topHit = hitTest(w.root, 2, 0)
  const midHit = hitTest(w.root, 2, 5)
  w.clicked.length = 0
  dispatchClick(w.root, 2, 5, false)
  check(
    `regionScroll=${regionScroll}: after scrolling up by 3, hitTest and dispatchClick hit item 7 at row 0 and item 12 at row 5`,
    rowOf(afterUp.frame.screen, 0) === 'item 07' &&
      topHit?.parentNode?.attributes['data-badge'] === 'badge-7' &&
      midHit?.parentNode?.attributes['data-badge'] === 'badge-12' &&
      w.clicked[0]?.id === 'item-12' &&
      w.clicked[0]?.localRow === 0,
    JSON.stringify({ row0: rowOf(afterUp.frame.screen, 0), topBadge: topHit?.parentNode?.attributes['data-badge'], midBadge: midHit?.parentNode?.attributes['data-badge'], clicked: w.clicked }),
  )
  check(
    `regionScroll=${regionScroll}: items scrolled below the viewport (items 17..19) are evicted from nodeCache`,
    !nodeCache.has(w.items[17]!) && !nodeCache.has(w.items[19]!),
  )
}

console.log('\n§2 PC-28: inserting or growing a row above the viewport while following the tail never shifts upper rows')
{
  const ctx = makeContext()
  const live = makeScrollWorld(ctx, 40, 10, true)
  const fresh = makeScrollWorld(ctx, 40, 10, true)
  live.paint(false)
  fresh.paint(true)

  for (const w of [live, fresh]) {
    const tail = buildDom({ kind: 'box', style: { flexDirection: 'row', width: 40 }, children: [{ kind: 'text', text: 'item 20 tail' }] })
    w.items.push(tail)
    appendChildNode(w.content, tail)
  }
  live.paint(false)
  fresh.paint(true)

  for (const w of [live, fresh]) {
    const above = buildDom({ kind: 'box', style: { flexDirection: 'row', width: 40 }, children: [{ kind: 'text', text: 'inserted above' }] })
    insertBeforeNode(w.content, above, w.items[5]!)
    w.items.splice(5, 0, above)
  }
  const rLive = live.paint(false)
  const rFresh = fresh.paint(true)
  const diffInsert = difference(rLive.frame.screen, rFresh.frame.screen)
  check(
    'inserting a row above the viewport at the tail emits no scrollHint and keeps all 10 visible rows aligned',
    rLive.signals.scrollHint === null && diffInsert === null,
    JSON.stringify({ scrollHint: rLive.signals.scrollHint, diffInsert }),
  )

  for (const w of [live, fresh]) {
    const textNode = w.items[3]!.childNodes[0]!.childNodes[0] as TextNode
    setTextNodeValue(textNode, 'grown one\ngrown two')
  }
  const gLive = live.paint(false)
  const gFresh = fresh.paint(true)
  const diffGrow = difference(gLive.frame.screen, gFresh.frame.screen)
  check(
    'growing an existing row above the viewport at the tail emits no scrollHint and keeps all 10 visible rows aligned',
    gLive.signals.scrollHint === null && diffGrow === null,
    JSON.stringify({ scrollHint: gLive.signals.scrollHint, diffGrow }),
  )
}

console.log('\n§3 Seeded differential walks (CHROME + CARD + PANE, ground off: shift + reuse active across 3 shapes × 24 seeds × 120 steps)')
{
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
  type World = { root: DOMElement; render: ReturnType<typeof createRenderer>; frames: [Frame, Frame] }
  const paint = (world: World, cols: number, rows: number, fromScratch: boolean, regionScroll: boolean): Screen => {
    world.root.layoutNode!.calculateLayout(cols, rows)
    const [front, back] = world.frames
    const { frame } = world.render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: fromScratch, regionScrollUsable: regionScroll })
    world.frames = [frame, front]
    return frame.screen
  }
  const COLOURS = ['#101820', '#201810', '#3a2a10', '#102a3a', 'rgb(13,24,27)']
  const WORDS = ['steady', 'prose', 'that', 'stays', '漢字', 'wide', 'a', 'tail', 'line', 'of', 'the', 'reply', 'ok', '✓', 'grows', 'x']
  type Item = { el: DOMElement; text: DOMElement; bubble: boolean }
  type Tree = World & { ground: DOMElement; capsule: DOMElement; rail: DOMElement; railLines: DOMElement[]; spinner: DOMElement; label: DOMElement; timer: DOMElement; transcript: DOMElement; content: DOMElement; items: Item[]; footer: DOMElement; footerRow: DOMElement; card: { host: DOMElement; card: DOMElement; answer: DOMElement } | null }
  type Shape = { name: string; cols: number; rows: number; withRail: boolean; regionScroll: boolean; paddingTop: number }
  type Model = { items: number; bubbles: boolean[]; railShown: boolean; border: boolean; card: boolean }
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
    return bubble === undefined ? { el: line, text: line, bubble: false } : { el: box({ backgroundColor: bubble as never, paddingLeft: 1, paddingRight: 1, flexDirection: 'row' }, [line]), text: line, bubble: true }
  }
  const build = (ctx: ComposeContext, shape: Shape): Tree => {
    const { cols, rows } = shape
    const root = createNode('ink-root')
    applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
    const spinner = text('✹')
    const label = text('Molting…')
    const timer = text('(1s)')
    const capsule = box({ flexDirection: 'row', borderStyle: 'round', flexGrow: 1 }, [spinner, text(' '), label, text(' '), timer])
    const band = box({ flexDirection: 'row', borderStyle: 'round', width: shape.withRail ? cols - 14 : cols }, [box({ width: 7 }, [text(' ▄▄▄ \n █▀█ \n ▀▀▀ ')]), capsule])
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
    const groundBox = box({ width: cols, height: rows, overflow: 'hidden' }, [row, footerRow])
    appendChildNode(root, groundBox)
    return { root, render: createRenderer(root, ctx.stylePool), frames: [emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)], ground: groundBox, capsule, rail, railLines, spinner, label, timer, transcript, content, items, footer, footerRow, card: null }
  }
  const KINDS = ['rest', 'spinner', 'label', 'timer', 'rail-line', 'footer', 'border', 'rail-toggle', 'card-open', 'card-answer', 'card-margin', 'card-close', 'item-text', 'item-lines', 'append', 'remove', 'insert', 'scroll', 'scroll-end', 'bubble-colour']
  const WEIGHTS: Record<string, number> = { rest: 4, spinner: 10, label: 6, timer: 6, 'rail-line': 4, footer: 3, border: 2, 'rail-toggle': 2, 'card-open': 3, 'card-answer': 5, 'card-margin': 3, 'card-close': 2, 'item-text': 8, 'item-lines': 4, append: 6, remove: 3, insert: 3, scroll: 8, 'scroll-end': 2, 'bubble-colour': 3 }
  function next(rand: () => number, model: Model, shape: Shape): Step {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
    const words = (n: number): string => Array.from({ length: n }, () => pick(WORDS)).join(' ')
    const usable = KINDS.filter(k => (k !== 'rail-line' && k !== 'rail-toggle' || shape.withRail) && (k !== 'remove' || model.items > 8) && (k !== 'card-open' || !model.card) && (!['card-answer', 'card-margin', 'card-close'].includes(k) || model.card))
    let roll = rand() * usable.reduce((n, k) => n + WEIGHTS[k]!, 0)
    let kind = usable[0]!
    for (const candidate of usable) {
      if (roll < WEIGHTS[candidate]!) { kind = candidate; break }
      roll -= WEIGHTS[candidate]!
    }
    switch (kind) {
      case 'spinner': { const g = pick(['✹', '✺', '✶', '·']); return { kind, say: `spinner ${g}`, apply: t => retext(t.spinner, g) } }
      case 'label': { const s = `${words(int(1, 3))}…`; return { kind, say: `label ${s}`, apply: t => retext(t.label, s) } }
      case 'timer': { const s = `(${int(1, 120)}s)`; return { kind, say: `timer ${s}`, apply: t => retext(t.timer, s) } }
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
    for (let seed = 1; seed <= 24; seed++) {
      const rand = prng(seed * 7919 + shape.cols)
      const ctx = makeContext()
      const live = build(ctx, shape)
      const fresh = build(ctx, shape)
      const model: Model = { items: live.items.length, bubbles: live.items.map(e => e.bubble), railShown: true, border: true, card: false }
      paint(live, shape.cols, shape.rows, false, shape.regionScroll)
      paint(fresh, shape.cols, shape.rows, true, shape.regionScroll)
      for (let step = 0; step < 120; step++) {
        const move = next(rand, model, shape)
        if (live.transcript.scroll) fresh.transcript.scroll = { ...live.transcript.scroll }
        move.apply(live, shape)
        move.apply(fresh, shape)
        const reused = paint(live, shape.cols, shape.rows, false, shape.regionScroll)
        const diff = difference(reused, paint(fresh, shape.cols, shape.rows, true, shape.regionScroll))
        if (diff !== null) {
          wrong.push(`seed=${seed} step=${step} (${move.say}): ${diff}`)
          break
        }
      }
    }
    check(`${shape.name}: all 24 walks × 120 steps equal fresh paint`, wrong.length === 0, wrong[0] ?? '')
  }
}

console.log('\n§4 Scroll region-hint recovery after a reaching child is removed, shrinks, or hides (E-S3)')
{
  function makeReachScrollPair(cols: number, rows: number) {
    const buildOne = (ctx: ComposeContext) => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
      const reachText = createTextNode('scroll item words wrapping onto next row inside one-row box')
      const reachLeaf = createNode('ink-text')
      appendChildNode(reachLeaf, reachText)
      const reachRow = createNode('ink-box')
      applySceneStyle(reachRow, { flexDirection: 'row', height: 1, flexShrink: 0, width: cols })
      appendChildNode(reachRow, reachLeaf)
      const content = createNode('ink-box')
      applySceneStyle(content, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
      appendChildNode(content, reachRow)
      for (let i = 1; i < 20; i++) {
        const line = createNode('ink-text')
        appendChildNode(line, createTextNode(`row ${String(i).padStart(2, '0')} plain`))
        const item = createNode('ink-box')
        applySceneStyle(item, { flexDirection: 'row', height: 1, flexShrink: 0, width: cols })
        appendChildNode(item, line)
        appendChildNode(content, item)
      }
      const scroller = createNode('ink-box')
      applySceneStyle(scroller, { flexDirection: 'column', width: cols, height: rows, overflowX: 'scroll', overflowY: 'scroll' })
      appendChildNode(scroller, content)
      const ground = createNode('ink-box')
      applySceneStyle(ground, { width: cols, height: rows, flexDirection: 'column', backgroundColor: '#102030' as never })
      appendChildNode(ground, scroller)
      appendChildNode(root, ground)
      const render = createRenderer(root, ctx.stylePool)
      let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
      let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
      return {
        root,
        scroller,
        content,
        reachRow,
        reachText,
        paint(scratch: boolean) {
          root.layoutNode!.calculateLayout(cols, rows)
          const res = render({
            frontFrame: front,
            backFrame: back,
            isTTY: true,
            terminalWidth: cols,
            terminalRows: rows,
            altScreen: true,
            prevFrameContaminated: scratch,
            regionScrollUsable: true,
          })
          back = front
          front = res.frame
          return res
        },
      }
    }
    const live = buildOne(makeContext())
    const fresh = buildOne(makeContext())
    live.paint(false)
    fresh.paint(true)
    const wheel = (deltas: readonly number[]) => {
      let hints = 0
      let firstDiff: string | null = null
      for (let i = 0; i < deltas.length; i++) {
        const d = deltas[i]!
        for (const w of [live, fresh]) {
          ;(w.scroller.scroll ??= {}).pendingScrollDelta = d
          w.scroller.scroll.stickyScroll = false
          markDirty(w.scroller)
        }
        const rLive = live.paint(false)
        const rFresh = fresh.paint(true)
        if (rLive.signals.scrollHint !== null) hints++
        if (firstDiff === null) {
          const diff = difference(rLive.frame.screen, rFresh.frame.screen)
          if (diff !== null) firstDiff = `step ${i} (delta=${d}): ${diff}`
        }
      }
      return { hints, firstDiff }
    }
    return { live, fresh, wheel }
  }

  const DOWN8_UP4 = [1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1]
  const UP4_DOWN8 = [-1, -1, -1, -1, 1, 1, 1, 1, 1, 1, 1, 1]

  {
    const pair = makeReachScrollPair(24, 6)
    const whileReaching = pair.wheel(DOWN8_UP4)
    check(
      'scroll box that still holds a reaching row withholds the region hint (0 of 12) and matches fresh paint',
      whileReaching.hints === 0 && whileReaching.firstDiff === null,
      JSON.stringify(whileReaching),
    )
    for (const w of [pair.live, pair.fresh]) {
      const plainLine = createNode('ink-text')
      appendChildNode(plainLine, createTextNode('row 00 plain replacement'))
      const plainItem = createNode('ink-box')
      applySceneStyle(plainItem, { flexDirection: 'row', height: 1, flexShrink: 0, width: 24 })
      appendChildNode(plainItem, plainLine)
      insertBeforeNode(w.content, plainItem, w.reachRow)
      removeChildNode(w.content, w.reachRow)
    }
    const rLive = pair.live.paint(false)
    const rFresh = pair.fresh.paint(true)
    const replaceDiff = difference(rLive.frame.screen, rFresh.frame.screen)
    const afterRemoval = pair.wheel(UP4_DOWN8)
    check(
      'scroll box that held a reaching row and removed it takes the region hint again (12 of 12) and matches fresh paint',
      replaceDiff === null && afterRemoval.hints === 12 && afterRemoval.firstDiff === null,
      JSON.stringify({ replaceDiff, afterRemoval }),
    )
  }

  {
    const pair = makeReachScrollPair(24, 6)
    for (const w of [pair.live, pair.fresh]) {
      setTextNodeValue(w.reachText, 'row 00 short')
    }
    const rLive = pair.live.paint(false)
    const rFresh = pair.fresh.paint(true)
    const shrinkDiff = difference(rLive.frame.screen, rFresh.frame.screen)
    const afterShrink = pair.wheel(DOWN8_UP4)
    check(
      'scroll box whose onscreen reaching row stops reaching takes the region hint again (12 of 12) and matches fresh paint',
      shrinkDiff === null && afterShrink.hints === 12 && afterShrink.firstDiff === null,
      JSON.stringify({ shrinkDiff, afterShrink }),
    )
  }

  {
    const pair = makeReachScrollPair(24, 6)
    const before = pair.wheel(DOWN8_UP4)
    for (const w of [pair.live, pair.fresh]) {
      setTextNodeValue(w.reachText, 'row 00 short offscreen')
    }
    const rLive = pair.live.paint(false)
    const rFresh = pair.fresh.paint(true)
    const shrinkDiff = difference(rLive.frame.screen, rFresh.frame.screen)
    const afterOffscreenShrink = pair.wheel(UP4_DOWN8)
    check(
      'scroll box whose culled offscreen reaching row stops reaching at scrollTop=4 takes the region hint again (12 of 12)',
      before.hints === 0 && before.firstDiff === null && shrinkDiff === null && afterOffscreenShrink.hints === 12 && afterOffscreenShrink.firstDiff === null,
      JSON.stringify({ before, shrinkDiff, afterOffscreenShrink }),
    )
  }

  {
    const pair = makeReachScrollPair(24, 6)
    for (const w of [pair.live, pair.fresh]) {
      applySceneStyle(w.reachRow, { flexDirection: 'row', height: 1, flexShrink: 0, width: 24, display: 'none' })
    }
    const rLive = pair.live.paint(false)
    const rFresh = pair.fresh.paint(true)
    const hideDiff = difference(rLive.frame.screen, rFresh.frame.screen)
    const afterHide = pair.wheel(DOWN8_UP4)
    check(
      'scroll box whose reaching row hides with display none takes the region hint again (12 of 12) and matches fresh paint',
      hideDiff === null && afterHide.hints === 12 && afterHide.firstDiff === null,
      JSON.stringify({ hideDiff, afterHide }),
    )
  }

  {
    const cols = 40
    const rows = 8
    const wrong: string[] = []
    let postClearHints = 0
    for (let seed = 1; seed <= 24; seed++) {
      let a = (seed * 104729) >>> 0
      const rand = () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
      }
      type RowEntry = { box: DOMElement; txt: TextNode; reaching: boolean }
      const buildFuzz = (ctx: ComposeContext) => {
        const root = createNode('ink-root')
        applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
        const content = createNode('ink-box')
        applySceneStyle(content, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
        const entries: RowEntry[] = []
        for (let i = 0; i < 18; i++) {
          const txt = createTextNode(`item ${i} steady`)
          const leaf = createNode('ink-text')
          appendChildNode(leaf, txt)
          const b = createNode('ink-box')
          applySceneStyle(b, { flexDirection: 'row', height: 1, flexShrink: 0, width: cols })
          appendChildNode(b, leaf)
          appendChildNode(content, b)
          entries.push({ box: b, txt, reaching: false })
        }
        const scroller = createNode('ink-box')
        applySceneStyle(scroller, { flexDirection: 'column', width: cols, height: rows, overflowX: 'scroll', overflowY: 'scroll' })
        appendChildNode(scroller, content)
        appendChildNode(root, scroller)
        const render = createRenderer(root, ctx.stylePool)
        let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
        let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
        return {
          root,
          content,
          scroller,
          entries,
          paint(scratch: boolean) {
            root.layoutNode!.calculateLayout(cols, rows)
            const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
            back = front
            front = res.frame
            return res
          },
        }
      }
      const live = buildFuzz(makeContext())
      const fresh = buildFuzz(makeContext())
      live.paint(false)
      fresh.paint(true)
      let hadReach = false
      for (let step = 0; step < 80; step++) {
        const r = rand()
        const anyReaching = live.entries.some(e => e.reaching)
        if (anyReaching) hadReach = true
        if (r < 0.22) {
          const idx = Math.floor(rand() * live.entries.length)
          const makeTall = rand() < 0.45
          const words = makeTall
            ? `long overflowing line ${step} that wraps past forty columns onto row two`
            : `short ${step}`
          for (const w of [live, fresh]) {
            setTextNodeValue(w.entries[idx]!.txt, words)
            w.entries[idx]!.reaching = makeTall
          }
        } else if (r < 0.34 && anyReaching) {
          for (const w of [live, fresh]) {
            for (const e of w.entries) {
              if (e.reaching) {
                setTextNodeValue(e.txt, `cleared ${step}`)
                e.reaching = false
              }
            }
          }
        } else if (r < 0.44 && live.entries.length > 12) {
          const idx = Math.floor(rand() * live.entries.length)
          for (const w of [live, fresh]) {
            const [gone] = w.entries.splice(idx, 1)
            removeChildNode(w.content, gone!.box)
          }
        } else {
          const deltas = [-2, -1, -1, 1, 1, 2]
          const d = deltas[Math.floor(rand() * deltas.length)]!
          for (const w of [live, fresh]) {
            ;(w.scroller.scroll ??= {}).pendingScrollDelta = d
            w.scroller.scroll.stickyScroll = false
            markDirty(w.scroller)
          }
        }
        const rLive = live.paint(false)
        const rFresh = fresh.paint(true)
        if (hadReach && !live.entries.some(e => e.reaching) && rLive.signals.scrollHint !== null) {
          postClearHints++
        }
        const diff = difference(rLive.frame.screen, rFresh.frame.screen)
        if (diff !== null) {
          wrong.push(`seed=${seed} step=${step}: ${diff}`)
          break
        }
      }
    }
    check(
      `seeded scroll-reach walks (24 seeds × 80 steps) equal fresh paint and recover region hints (${postClearHints} post-clear hints)`,
      wrong.length === 0 && postClearHints >= 100,
      wrong[0] ?? `postClearHints=${postClearHints}`,
    )
  }
}

console.log('\n§5 Hidden rows in a scroll box changing while hidden, unhiding, or hiding while reaching never wipe visible rows (MUST 4b)')
{
  const cols = 40
  const rows = 14
  const LONG = 'is a long line that wraps past the forty columns of this box, twice over, yes it does'

  function runHiddenWipeScenes(): { bad: number; detail: string; hintsOnWheel: number } {
    let bad = 0
    let firstDetail = ''
    let hintsOnWheel = 0
    for (const bg of [undefined, '#102030']) {
      for (const tallKind of [false, true]) {
        const buildOne = (ctx: ComposeContext) => {
          const root = createNode('ink-root')
          applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
          const head = createNode('ink-text')
          appendChildNode(head, createTextNode('head'))
          const foot = createNode('ink-text')
          appendChildNode(foot, createTextNode('foot'))
          const content = createNode('ink-box')
          applySceneStyle(content, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
          const rowBoxes: DOMElement[] = []
          const rowTexts: TextNode[] = []
          for (let i = 0; i < 22; i++) {
            const isTarget = i === 12
            const txt = createTextNode(isTarget && tallKind ? `row ${i}.0 ${LONG}` : `row ${i}.0`)
            const leaf = createNode('ink-text')
            appendChildNode(leaf, txt)
            const b = createNode('ink-box')
            applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, ...(isTarget && tallKind ? { height: 1 } : {}) })
            appendChildNode(b, leaf)
            appendChildNode(content, b)
            rowBoxes.push(b)
            rowTexts.push(txt)
          }
          const scroller = createNode('ink-box')
          applySceneStyle(scroller, { flexDirection: 'column', width: cols, height: 10, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
          appendChildNode(scroller, content)
          const host = createNode('ink-box')
          applySceneStyle(host, { width: cols, height: rows, flexDirection: 'column', ...(bg ? { backgroundColor: bg as never } : {}) })
          appendChildNode(host, head)
          appendChildNode(host, scroller)
          appendChildNode(host, foot)
          appendChildNode(root, host)
          const render = createRenderer(root, ctx.stylePool)
          let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          return {
            root,
            scroller,
            rowBoxes,
            rowTexts,
            paint(scratch: boolean) {
              root.layoutNode!.calculateLayout(cols, rows)
              const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
              back = front
              front = res.frame
              return res
            },
          }
        }
        const live = buildOne(makeContext())
        const fresh = buildOne(makeContext())
        const step = (label: string, delta: number, mutate?: (w: ReturnType<typeof buildOne>) => void): boolean => {
          for (const w of [live, fresh]) {
            mutate?.(w)
            if (delta !== 0) {
              ;(w.scroller.scroll ??= {}).pendingScrollDelta = delta
              w.scroller.scroll.stickyScroll = false
              markDirty(w.scroller)
            }
          }
          const rLive = live.paint(false)
          if (live.scroller.scroll) fresh.scroller.scroll = { scrollTop: live.scroller.scroll.scrollTop }
          const rFresh = fresh.paint(true)
          const diff = difference(rLive.frame.screen, rFresh.frame.screen)
          if (diff !== null) {
            bad++
            if (!firstDetail) firstDetail = `${bg ? 'grounded' : 'ungrounded'} tall=${tallKind} (${label}): ${diff}`
          }
          return rLive.signals.scrollHint !== null
        }
        step('first', 0)
        step('wheel 4', 4)
        step('hide row 12', 0, w => applySceneStyle(w.rowBoxes[12]!, { flexDirection: 'row', flexShrink: 0, width: cols, ...(tallKind ? { height: 1 } : {}), display: 'none' }))
        step('wheel -4', -4)
        step('wheel 4 again', 4)
        step('still', 0)
        if (step('change hidden row text + wheel 1', 1, w => setTextNodeValue(w.rowTexts[12]!, tallKind ? 'row 12.1' : `row 12.1 ${LONG}`))) {
          hintsOnWheel++
        }
        step('wheel -3', -3)
        step('still end', 0)
      }
    }
    return { bad, detail: firstDetail, hintsOnWheel }
  }

  const sceneRes = runHiddenWipeScenes()
  check(
    `hidden plain and reaching rows changing on a wheel shift never wipe a visible row (0 differing frames across 4 scenes, ${sceneRes.hintsOnWheel}/4 hinted)`,
    sceneRes.bad === 0 && sceneRes.hintsOnWheel === 4,
    `${sceneRes.bad} differing (${sceneRes.detail}), hints=${sceneRes.hintsOnWheel}`,
  )

  {
    let bad = 0
    let firstDetail = ''
    let recoveredHints = 0
    for (const bg of [undefined, '#102030']) {
      for (let seed = 1; seed <= 20; seed++) {
        let s = (seed * 7919 + (bg ? 13 : 0)) >>> 0
        const rnd = (n: number) => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0
          return Math.floor((s / 4294967296) * n)
        }
        type Kind = 'plain' | 'tall' | 'deep' | 'clip' | 'zero'
        const KINDS: Kind[] = ['plain', 'plain', 'tall', 'deep', 'clip', 'zero']
        type Entry = { id: number; kind: Kind; long: boolean; hidden: boolean; rev: number; box: DOMElement; inner1?: DOMElement; inner2?: DOMElement; txt?: TextNode }
        const makeDomRow = (id: number, kind: Kind, long: boolean, hidden: boolean, rev: number): Entry => {
          const hideStyle: Styles = hidden ? { display: 'none' } : {}
          const words = `row ${id}.${rev}${long ? ' ' + LONG : ''}`
          const b = createNode('ink-box')
          if (kind === 'zero') {
            applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, height: 0, ...hideStyle })
            return { id, kind, long, hidden, rev, box: b }
          }
          const txt = createTextNode(words)
          const leaf = createNode('ink-text')
          appendChildNode(leaf, txt)
          if (kind === 'deep') {
            const in2 = createNode('ink-box')
            applySceneStyle(in2, { flexDirection: 'row', flexShrink: 0 })
            appendChildNode(in2, leaf)
            const in1 = createNode('ink-box')
            applySceneStyle(in1, { flexDirection: 'row', flexShrink: 0, height: 1, width: cols })
            appendChildNode(in1, in2)
            applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, height: 1, width: cols, ...hideStyle })
            appendChildNode(b, in1)
            return { id, kind, long, hidden, rev, box: b, inner1: in1, inner2: in2, txt }
          }
          applySceneStyle(b, {
            flexDirection: 'row',
            flexShrink: 0,
            width: cols,
            ...(kind === 'tall' || kind === 'clip' ? { height: 1 } : {}),
            ...(kind === 'clip' ? { overflowX: 'hidden', overflowY: 'hidden' } : {}),
            ...hideStyle,
          })
          appendChildNode(b, leaf)
          return { id, kind, long, hidden, rev, box: b, txt }
        }
        const syncEntry = (e: Entry) => {
          const hideStyle: Styles = e.hidden ? { display: 'none' } : { display: undefined }
          if (e.kind === 'zero') {
            applySceneStyle(e.box, { flexDirection: 'row', flexShrink: 0, width: cols, height: 0, ...hideStyle })
            return
          }
          if (e.txt) setTextNodeValue(e.txt, `row ${e.id}.${e.rev}${e.long ? ' ' + LONG : ''}`)
          applySceneStyle(e.box, {
            flexDirection: 'row',
            flexShrink: 0,
            width: cols,
            ...(e.kind === 'tall' || e.kind === 'deep' || e.kind === 'clip' ? { height: 1 } : {}),
            ...(e.kind === 'clip' ? { overflowX: 'hidden', overflowY: 'hidden' } : {}),
            ...hideStyle,
          })
        }
        const buildWalk = (ctx: ComposeContext, initialSpecs: Array<{ id: number; kind: Kind; long: boolean; hidden: boolean; rev: number }>) => {
          const root = createNode('ink-root')
          applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
          const head = createNode('ink-text')
          appendChildNode(head, createTextNode('head'))
          const foot = createNode('ink-text')
          appendChildNode(foot, createTextNode('foot'))
          const content = createNode('ink-box')
          applySceneStyle(content, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
          const entries = initialSpecs.map(sp => {
            const e = makeDomRow(sp.id, sp.kind, sp.long, sp.hidden, sp.rev)
            appendChildNode(content, e.box)
            return e
          })
          const scroller = createNode('ink-box')
          applySceneStyle(scroller, { flexDirection: 'column', width: cols, height: 10, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
          appendChildNode(scroller, content)
          const host = createNode('ink-box')
          applySceneStyle(host, { width: cols, height: rows, flexDirection: 'column', ...(bg ? { backgroundColor: bg as never } : {}) })
          appendChildNode(host, head)
          appendChildNode(host, scroller)
          appendChildNode(host, foot)
          appendChildNode(root, host)
          const render = createRenderer(root, ctx.stylePool)
          let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          return {
            root,
            content,
            scroller,
            entries,
            paint(scratch: boolean) {
              root.layoutNode!.calculateLayout(cols, rows)
              const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
              back = front
              front = res.frame
              return res
            },
          }
        }
        const freshFromSpecs = (ctx: ComposeContext, entries: Entry[], scrollTop: number): Screen => {
          const w = buildWalk(
            ctx,
            entries.map(e => ({ id: e.id, kind: e.kind, long: e.long, hidden: e.hidden, rev: e.rev })),
          )
          w.scroller.scroll = { scrollTop }
          return w.paint(true).frame.screen
        }
        const freshCtx = makeContext()
        let nextId = 22
        const specs = Array.from({ length: 22 }, (_, id) => ({ id, kind: KINDS[rnd(KINDS.length)]!, long: rnd(3) === 0, hidden: false, rev: 0 }))
        const live = buildWalk(freshCtx, specs)
        live.paint(false)
        for (let st = 0; st < 55; st++) {
          const pick = rnd(7)
          const n = live.entries.length
          if (pick === 0 && n > 0) {
            const idx = rnd(n)
            const e = live.entries[idx]!
            e.hidden = !e.hidden
            syncEntry(e)
          } else if (pick === 1 && n > 0) {
            const hiddenIdx = live.entries.map((e, idx) => (e.hidden ? idx : -1)).filter(idx => idx >= 0)
            const idx = hiddenIdx.length > 0 ? hiddenIdx[rnd(hiddenIdx.length)]! : rnd(n)
            const flipLong = rnd(2) === 0
            const e = live.entries[idx]!
            e.rev++
            if (flipLong) e.long = !e.long
            syncEntry(e)
          } else if (pick === 2 && n > 10) {
            const hiddenIdx = live.entries.map((e, idx) => (e.hidden ? idx : -1)).filter(idx => idx >= 0)
            const idx = hiddenIdx.length > 0 ? hiddenIdx[rnd(hiddenIdx.length)]! : rnd(n)
            const [gone] = live.entries.splice(idx, 1)
            removeChildNode(live.content, gone!.box)
          } else if (pick === 3) {
            const id = nextId++
            const kind = KINDS[rnd(KINDS.length)]!
            const long = rnd(2) === 0
            const hidden = rnd(4) === 0
            const at = rnd(n + 1)
            const e = makeDomRow(id, kind, long, hidden, 0)
            if (at >= live.entries.length) appendChildNode(live.content, e.box)
            else insertBeforeNode(live.content, e.box, live.entries[at]!.box)
            live.entries.splice(at, 0, e)
          } else if (pick === 4 && n > 0) {
            const idx = rnd(n)
            const e = live.entries[idx]!
            e.long = !e.long
            e.rev++
            syncEntry(e)
          }
          const wheel = rnd(4) === 0 ? 0 : [-3, -2, -1, 1, 1, 2, 3][rnd(7)]!
          if (wheel !== 0) {
            ;(live.scroller.scroll ??= {}).pendingScrollDelta = wheel
            live.scroller.scroll.stickyScroll = false
            markDirty(live.scroller)
          }
          const rLive = live.paint(false)
          const rFresh = freshFromSpecs(freshCtx, live.entries, live.scroller.scroll?.scrollTop ?? 0)
          const diff = difference(rLive.frame.screen, rFresh)
          if (diff !== null) {
            bad++
            if (!firstDetail) firstDetail = `${bg ? 'grounded' : 'ungrounded'} seed=${seed} step=${st}: ${diff}`
          }
        }
        for (const e of live.entries) {
          if (e.kind === 'tall' || e.kind === 'deep') {
            if (seed % 2 === 0) e.hidden = true
            else e.long = false
            e.rev++
            syncEntry(e)
          }
        }
        while (live.entries.filter(e => !e.hidden && e.kind !== 'zero').length < 22) {
          const id = nextId++
          const e = makeDomRow(id, 'plain', false, false, 0)
          appendChildNode(live.content, e.box)
          live.entries.push(e)
        }
        ;(live.scroller.scroll ??= {}).scrollTop = 0
        live.scroller.scroll.pendingScrollDelta = undefined
        live.scroller.scroll.stickyScroll = false
        markDirty(live.scroller)
        live.paint(false)
        for (let i = 0; i < 12; i++) {
          const d = i < 8 ? 1 : -1
          ;(live.scroller.scroll ??= {}).pendingScrollDelta = d
          live.scroller.scroll.stickyScroll = false
          markDirty(live.scroller)
          const rLive = live.paint(false)
          const rFresh = freshFromSpecs(freshCtx, live.entries, live.scroller.scroll?.scrollTop ?? 0)
          if (rLive.signals.scrollHint !== null) recoveredHints++
          const diff = difference(rLive.frame.screen, rFresh)
          if (diff !== null) {
            bad++
            if (!firstDetail) firstDetail = `${bg ? 'grounded' : 'ungrounded'} seed=${seed} tail=${i}: ${diff}`
          }
        }
      }
    }
    check(
      `seeded hiding walks (2 grounds × 20 seeds × 55 steps + 12-wheel tail) equal fresh paint and recover region hints (${recoveredHints}/480)`,
      bad === 0 && recoveredHints === 480,
      `${bad} differing (${firstDetail}), hints=${recoveredHints}/480`,
    )
  }
}

console.log('\n§6 Reordering a culled reaching row preserves its reach when wheeled back into view (MUST 4a)')
{
  const cols = 40
  const rows = 14
  const LONG = 'is a long line that wraps past the forty columns of this box, twice over, yes it does'

  let sceneBad = 0
  let sceneDetail = ''
  for (const bg of [undefined, '#102030']) {
    const ctx = makeContext()
    const buildWorld = (itemsSpec: Array<{ id: number; tall2Long: boolean }>) => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
      const head = createNode('ink-text')
      appendChildNode(head, createTextNode('head'))
      const foot = createNode('ink-text')
      appendChildNode(foot, createTextNode('foot'))
      const content = createNode('ink-box')
      applySceneStyle(content, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
      const rowNodes = itemsSpec.map(sp => {
        const txt = createTextNode(sp.tall2Long ? `row ${sp.id}.0 ${LONG}` : `row ${sp.id}.0`)
        const leaf = createNode('ink-text')
        appendChildNode(leaf, txt)
        const b = createNode('ink-box')
        applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, ...(sp.tall2Long ? { height: 2 } : {}) })
        appendChildNode(b, leaf)
        appendChildNode(content, b)
        return { id: sp.id, tall2Long: sp.tall2Long, box: b }
      })
      const scroller = createNode('ink-box')
      applySceneStyle(scroller, { flexDirection: 'column', width: cols, height: 10, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
      appendChildNode(scroller, content)
      const host = createNode('ink-box')
      applySceneStyle(host, { width: cols, height: rows, flexDirection: 'column', ...(bg ? { backgroundColor: bg as never } : {}) })
      appendChildNode(host, head)
      appendChildNode(host, scroller)
      appendChildNode(host, foot)
      appendChildNode(root, host)
      const render = createRenderer(root, ctx.stylePool)
      let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
      let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
      return {
        root,
        content,
        scroller,
        rowNodes,
        paint(scratch: boolean) {
          root.layoutNode!.calculateLayout(cols, rows)
          const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
          back = front
          front = res.frame
          return res
        },
      }
    }
    const spec = Array.from({ length: 24 }, (_, id) => ({ id, tall2Long: id === 3 }))
    const live = buildWorld(spec)
    const runStep = (label: string, delta: number, reorder?: () => void) => {
      reorder?.()
      if (delta !== 0) {
        ;(live.scroller.scroll ??= {}).pendingScrollDelta = delta
        live.scroller.scroll.stickyScroll = false
        markDirty(live.scroller)
      }
      const rLive = live.paint(false)
      const fresh = buildWorld(spec)
      fresh.scroller.scroll = { scrollTop: live.scroller.scroll?.scrollTop ?? 0 }
      const rFresh = fresh.paint(true)
      const diff = difference(rLive.frame.screen, rFresh.frame.screen)
      if (diff !== null) {
        sceneBad++
        if (!sceneDetail) sceneDetail = `${bg ? 'grounded' : 'ungrounded'} (${label}): ${diff}`
      }
    }
    runStep('first', 0)
    runStep('wheel 7', 7)
    runStep('swap rows 3 and 5 while culled', 0, () => {
      const r3 = live.rowNodes[3]!
      const r5 = live.rowNodes[5]!
      const after5 = live.rowNodes[6]!.box
      const after3 = live.rowNodes[4]!.box
      insertBeforeNode(live.content, r5.box, after3)
      insertBeforeNode(live.content, r3.box, after5)
      live.rowNodes[3] = r5
      live.rowNodes[5] = r3
      const s3 = spec[3]!
      spec[3] = spec[5]!
      spec[5] = s3
    })
    runStep('wheel -2 brings reordered reaching row into top edge', -2)
    runStep('wheel -1', -1)
    runStep('wheel 1', 1)
    runStep('still', 0)
  }
  check(
    'swapping a culled reaching row with a sibling preserves its reach when wheeled back into view (0 differing frames across both grounds)',
    sceneBad === 0,
    `${sceneBad} differing (${sceneDetail})`,
  )

  {
    let fuzzBad = 0
    let fuzzDetail = ''
    for (const bg of [undefined, '#102030']) {
      for (let seed = 1; seed <= 16; seed++) {
        let s = (seed * 31337 + (bg ? 7 : 0)) >>> 0
        const rnd = (n: number) => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0
          return Math.floor((s / 4294967296) * n)
        }
        const ctx = makeContext()
        const spec = Array.from({ length: 22 }, (_, id) => ({ id, tall: rnd(4) === 0 }))
        const buildW = (sp: Array<{ id: number; tall: boolean }>) => {
          const root = createNode('ink-root')
          applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
          const head = createNode('ink-text')
          appendChildNode(head, createTextNode('head'))
          const foot = createNode('ink-text')
          appendChildNode(foot, createTextNode('foot'))
          const content = createNode('ink-box')
          applySceneStyle(content, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
          const nodes = sp.map(item => {
            const leaf = createNode('ink-text')
            appendChildNode(leaf, createTextNode(item.tall ? `row ${item.id} ${LONG}` : `row ${item.id}`))
            const b = createNode('ink-box')
            applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, height: item.tall ? 2 : 1 })
            appendChildNode(b, leaf)
            appendChildNode(content, b)
            return b
          })
          const scroller = createNode('ink-box')
          applySceneStyle(scroller, { flexDirection: 'column', width: cols, height: 10, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
          appendChildNode(scroller, content)
          const host = createNode('ink-box')
          applySceneStyle(host, { width: cols, height: rows, flexDirection: 'column', ...(bg ? { backgroundColor: bg as never } : {}) })
          appendChildNode(host, head)
          appendChildNode(host, scroller)
          appendChildNode(host, foot)
          appendChildNode(root, host)
          const render = createRenderer(root, ctx.stylePool)
          let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          return {
            root,
            content,
            scroller,
            nodes,
            paint(scratch: boolean) {
              root.layoutNode!.calculateLayout(cols, rows)
              const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
              back = front
              front = res.frame
              return res
            },
          }
        }
        const live = buildW(spec)
        live.paint(false)
        for (let st = 0; st < 40; st++) {
          if (rnd(2) === 0) {
            const i = rnd(spec.length)
            const j = rnd(spec.length)
            if (i !== j) {
              const ni = live.nodes[i]!
              const nj = live.nodes[j]!
              const afterJ = live.nodes[j + 1]
              const afterI = live.nodes[i + 1]
              if (afterI === nj) {
                insertBeforeNode(live.content, nj, ni)
              } else if (afterJ === ni) {
                insertBeforeNode(live.content, ni, nj)
              } else {
                if (afterI) insertBeforeNode(live.content, nj, afterI)
                else appendChildNode(live.content, nj)
                if (afterJ) insertBeforeNode(live.content, ni, afterJ)
                else appendChildNode(live.content, ni)
              }
              live.nodes[i] = nj
              live.nodes[j] = ni
              const si = spec[i]!
              spec[i] = spec[j]!
              spec[j] = si
            }
          }
          const d = [-3, -2, -1, 0, 1, 2, 3][rnd(7)]!
          if (d !== 0) {
            ;(live.scroller.scroll ??= {}).pendingScrollDelta = d
            live.scroller.scroll.stickyScroll = false
            markDirty(live.scroller)
          }
          const rLive = live.paint(false)
          const fresh = buildW(spec)
          fresh.scroller.scroll = { scrollTop: live.scroller.scroll?.scrollTop ?? 0 }
          const rFresh = fresh.paint(true)
          const diff = difference(rLive.frame.screen, rFresh.frame.screen)
          if (diff !== null) {
            fuzzBad++
            if (!fuzzDetail) fuzzDetail = `${bg ? 'grounded' : 'ungrounded'} seed=${seed} step=${st}: ${diff}`
          }
        }
      }
    }
    check(
      'seeded culled-reorder + wheel walks (2 grounds × 16 seeds × 40 steps) equal fresh paint',
      fuzzBad === 0,
      `${fuzzBad} differing (${fuzzDetail})`,
    )
  }
}

console.log('\n§7 Nested scroll boxes take the full path while mounted in view and restore region hints once gone')
{
  const cols = 40
  const rows = 14
  const LONG = 'is a long line that wraps past the forty columns of this box, twice over, yes it does'

  let minimalBad = 0
  let minimalDetail = ''
  for (const bg of [undefined, '#102030']) {
    const ctx = makeContext()
    const buildMinimal = () => {
      const root = createNode('ink-root')
      applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
      const head = createNode('ink-text')
      appendChildNode(head, createTextNode('head'))
      const foot = createNode('ink-text')
      appendChildNode(foot, createTextNode('foot'))
      const outerContent = createNode('ink-box')
      applySceneStyle(outerContent, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
      const innerContent = createNode('ink-box')
      applySceneStyle(innerContent, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
      for (let k = 0; k < 8; k++) {
        const leaf = createNode('ink-text')
        appendChildNode(leaf, createTextNode(`inner ${k}`))
        const b = createNode('ink-box')
        applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, height: 1 })
        appendChildNode(b, leaf)
        appendChildNode(innerContent, b)
      }
      const innerScroller = createNode('ink-box')
      applySceneStyle(innerScroller, { flexDirection: 'column', width: cols, height: 4, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
      appendChildNode(innerScroller, innerContent)
      for (let i = 0; i < 20; i++) {
        if (i === 5) appendChildNode(outerContent, innerScroller)
        const leaf = createNode('ink-text')
        appendChildNode(leaf, createTextNode(`outer ${i}`))
        const b = createNode('ink-box')
        applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, height: 1 })
        appendChildNode(b, leaf)
        appendChildNode(outerContent, b)
      }
      const outerScroller = createNode('ink-box')
      applySceneStyle(outerScroller, { flexDirection: 'column', width: cols, height: 10, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
      appendChildNode(outerScroller, outerContent)
      const host = createNode('ink-box')
      applySceneStyle(host, { width: cols, height: rows, flexDirection: 'column', ...(bg ? { backgroundColor: bg as never } : {}) })
      appendChildNode(host, head)
      appendChildNode(host, outerScroller)
      appendChildNode(host, foot)
      appendChildNode(root, host)
      const render = createRenderer(root, ctx.stylePool)
      let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
      let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
      return {
        root,
        outerScroller,
        innerScroller,
        paint(scratch: boolean) {
          root.layoutNode!.calculateLayout(cols, rows)
          const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
          back = front
          front = res.frame
          return res
        },
      }
    }
    const live = buildMinimal()
    const step = (label: string, dOut: number, dIn: number) => {
      if (dOut !== 0) {
        ;(live.outerScroller.scroll ??= {}).pendingScrollDelta = dOut
        live.outerScroller.scroll.stickyScroll = false
        markDirty(live.outerScroller)
      }
      if (dIn !== 0) {
        ;(live.innerScroller.scroll ??= {}).pendingScrollDelta = dIn
        live.innerScroller.scroll.stickyScroll = false
        markDirty(live.innerScroller)
      }
      const rLive = live.paint(false)
      const fresh = buildMinimal()
      fresh.outerScroller.scroll = { scrollTop: live.outerScroller.scroll?.scrollTop ?? 0 }
      fresh.innerScroller.scroll = { scrollTop: live.innerScroller.scroll?.scrollTop ?? 0 }
      const rFresh = fresh.paint(true)
      const diff = difference(rLive.frame.screen, rFresh.frame.screen)
      if (diff !== null) {
        minimalBad++
        if (!minimalDetail) minimalDetail = `${bg ? 'grounded' : 'ungrounded'} (${label}): ${diff}`
      }
    }
    step('first', 0, 0)
    step('scroll outer to 6 so nested scroll box stands partly above outer viewport', 6, 0)
    step('wheel inner by 2 while partly clipped by outer', 0, 2)
    step('wheel outer by 1', 1, 0)
    step('wheel inner by -1', 0, -1)
  }
  check(
    'wheeling a nested scroll box standing partly above the outer viewport never overwrites the header row (0 differing frames across both grounds)',
    minimalBad === 0,
    `${minimalBad} differing (${minimalDetail})`,
  )

  {
    let walkBad = 0
    let walkDetail = ''
    let tailHints = 0
    for (const bg of [undefined, '#102030']) {
      for (let seed = 1; seed <= 20; seed++) {
        let s = (seed * 9973 + (bg ? 19 : 0)) >>> 0
        const rnd = (n: number) => {
          s = (Math.imul(s, 1664525) + 1013904223) >>> 0
          return Math.floor((s / 4294967296) * n)
        }
        const ctx = makeContext()
        type Spec = { id: number; tall: boolean; rev: number; inner: boolean }
        const specs: Spec[] = Array.from({ length: 22 }, (_, id) => ({ id, tall: rnd(4) === 0, rev: 0, inner: false }))
        for (let k = 0; k < 6; k++) specs.push({ id: 22 + k, tall: false, rev: 0, inner: true })
        let innerSlot: number | null = 4 + rnd(6)
        const buildWorld = (curSpecs: Spec[], slot: number | null) => {
          const root = createNode('ink-root')
          applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
          const head = createNode('ink-text')
          appendChildNode(head, createTextNode('head'))
          const foot = createNode('ink-text')
          appendChildNode(foot, createTextNode('foot'))
          const outerContent = createNode('ink-box')
          applySceneStyle(outerContent, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
          let innerScroller: DOMElement | null = null
          const innerRows = curSpecs.filter(x => x.inner)
          const outerRows = curSpecs.filter(x => !x.inner)
          const mkRow = (sp: Spec) => {
            const txt = createTextNode(`row ${sp.id}.${sp.rev}${sp.tall ? ' ' + LONG : ''}`)
            const leaf = createNode('ink-text')
            appendChildNode(leaf, txt)
            const b = createNode('ink-box')
            applySceneStyle(b, { flexDirection: 'row', flexShrink: 0, width: cols, height: 1 })
            appendChildNode(b, leaf)
            return { sp, box: b, txt }
          }
          const outerMap = new Map<number, { box: DOMElement; txt: TextNode }>()
          if (slot !== null) {
            const innerContent = createNode('ink-box')
            applySceneStyle(innerContent, { flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: cols })
            for (const ir of innerRows) {
              const r = mkRow(ir)
              outerMap.set(ir.id, { box: r.box, txt: r.txt })
              appendChildNode(innerContent, r.box)
            }
            innerScroller = createNode('ink-box')
            applySceneStyle(innerScroller, { flexDirection: 'column', width: cols, height: 4, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
            appendChildNode(innerScroller, innerContent)
          }
          const insertAt = slot === null ? -1 : Math.min(slot, Math.max(0, outerRows.length - 1))
          outerRows.forEach((or, idx) => {
            if (innerScroller && idx === insertAt) appendChildNode(outerContent, innerScroller)
            const r = mkRow(or)
            outerMap.set(or.id, { box: r.box, txt: r.txt })
            appendChildNode(outerContent, r.box)
          })
          if (innerScroller && outerRows.length === 0) appendChildNode(outerContent, innerScroller)
          const outerScroller = createNode('ink-box')
          applySceneStyle(outerScroller, { flexDirection: 'column', width: cols, height: 10, flexShrink: 0, overflowX: 'scroll', overflowY: 'scroll' })
          appendChildNode(outerScroller, outerContent)
          const host = createNode('ink-box')
          applySceneStyle(host, { width: cols, height: rows, flexDirection: 'column', ...(bg ? { backgroundColor: bg as never } : {}) })
          appendChildNode(host, head)
          appendChildNode(host, outerScroller)
          appendChildNode(host, foot)
          appendChildNode(root, host)
          const render = createRenderer(root, ctx.stylePool)
          let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
          return {
            root,
            outerContent,
            outerScroller,
            innerScroller,
            outerMap,
            paint(scratch: boolean) {
              root.layoutNode!.calculateLayout(cols, rows)
              const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: true })
              back = front
              front = res.frame
              return res
            },
          }
        }
        const live = buildWorld(specs, innerSlot)
        live.paint(false)
        for (let st = 0; st < 45; st++) {
          const pick = rnd(4)
          if (pick === 0) {
            const target = specs[rnd(specs.length)]!
            target.rev++
            const entry = live.outerMap.get(target.id)
            if (entry) setTextNodeValue(entry.txt, `row ${target.id}.${target.rev}${target.tall ? ' ' + LONG : ''}`)
          } else if (pick === 1 && live.innerScroller) {
            const outers = specs.filter(x => !x.inner)
            if (outers.length > 4) {
              const newSlot = 2 + rnd(Math.min(10, outers.length - 2))
              innerSlot = newSlot
              const beforeTarget = live.outerMap.get(outers[newSlot]!.id)?.box
              if (beforeTarget && beforeTarget !== live.innerScroller) {
                insertBeforeNode(live.outerContent, live.innerScroller, beforeTarget)
              }
            }
          }
          const dOut = [-3, -2, -1, 0, 1, 1, 2, 3][rnd(8)]!
          const dIn = [-2, -1, 0, 1, 2][rnd(5)]!
          if (dOut !== 0) {
            ;(live.outerScroller.scroll ??= {}).pendingScrollDelta = dOut
            live.outerScroller.scroll.stickyScroll = false
            markDirty(live.outerScroller)
          }
          if (dIn !== 0 && live.innerScroller) {
            ;(live.innerScroller.scroll ??= {}).pendingScrollDelta = dIn
            live.innerScroller.scroll.stickyScroll = false
            markDirty(live.innerScroller)
          }
          const rLive = live.paint(false)
          const fresh = buildWorld(specs, innerSlot)
          fresh.outerScroller.scroll = { scrollTop: live.outerScroller.scroll?.scrollTop ?? 0 }
          if (fresh.innerScroller && live.innerScroller) {
            fresh.innerScroller.scroll = { scrollTop: live.innerScroller.scroll.scrollTop ?? 0 }
          }
          const rFresh = fresh.paint(true)
          const diff = difference(rLive.frame.screen, rFresh.frame.screen)
          if (diff !== null) {
            walkBad++
            if (!walkDetail) walkDetail = `${bg ? 'grounded' : 'ungrounded'} seed=${seed} step=${st}: ${diff}`
          }
        }
        if (live.innerScroller) {
          removeChildNode(live.outerContent, live.innerScroller)
          live.innerScroller = null
          innerSlot = null
        }
        for (const sp of specs) {
          if (!sp.inner && sp.tall) {
            sp.tall = false
            sp.rev++
            const entry = live.outerMap.get(sp.id)
            if (entry) setTextNodeValue(entry.txt, `row ${sp.id}.${sp.rev}`)
          }
        }
        ;(live.outerScroller.scroll ??= {}).scrollTop = 0
        live.outerScroller.scroll.pendingScrollDelta = undefined
        live.outerScroller.scroll.stickyScroll = false
        markDirty(live.outerScroller)
        live.paint(false)
        for (let i = 0; i < 12; i++) {
          const d = i < 8 ? 1 : -1
          ;(live.outerScroller.scroll ??= {}).pendingScrollDelta = d
          live.outerScroller.scroll.stickyScroll = false
          markDirty(live.outerScroller)
          const rLive = live.paint(false)
          const fresh = buildWorld(specs, null)
          fresh.outerScroller.scroll = { scrollTop: live.outerScroller.scroll?.scrollTop ?? 0 }
          const rFresh = fresh.paint(true)
          if (rLive.signals.scrollHint !== null) tailHints++
          const diff = difference(rLive.frame.screen, rFresh.frame.screen)
          if (diff !== null) {
            walkBad++
            if (!walkDetail) walkDetail = `${bg ? 'grounded' : 'ungrounded'} seed=${seed} tail=${i}: ${diff}`
          }
        }
      }
    }
    check(
      `seeded nested-scroll walks (2 grounds × 20 seeds × 45 steps + 12-wheel tail) equal fresh paint and recover region hints (${tailHints}/480)`,
      walkBad === 0 && tailHints === 480,
      `${walkBad} differing (${walkDetail}), hints=${tailHints}/480`,
    )
  }
}

console.log(`\nprove-scroll-shift-and-hit: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
