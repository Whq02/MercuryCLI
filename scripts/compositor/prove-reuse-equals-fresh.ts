#!/usr/bin/env bun
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

const { appendChildNode, createNode, createTextNode, insertBeforeNode, markDirty, removeChildNode, setAttribute, setTextNodeValue } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { applySceneStyle, makeContext } = await import('../ink-runtime/frameHarness.ts')
type ComposeContext = import('../ink-runtime/frameHarness.ts').ComposeContext
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
type Screen = import('../../src/ink/cell-grid.js').Screen
const { cellAt } = await import('../../src/ink/cell-grid.js')
type Styles = import('../../src/ink/styles.js').Styles

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1)
const SEEDS = Number(arg('--seeds') ?? 12)
const FIRST_SEED = Number(arg('--first') ?? 1)
const STEPS = Number(arg('--steps') ?? 100)

let checks = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
}
const section = (title: string): void => console.log(`\n${title}`)

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
function paint(world: World, cols: number, rows: number, fromScratch: boolean, regionScroll: boolean): Screen {
  world.root.layoutNode!.calculateLayout(cols, rows)
  const [front, back] = world.frames
  const { frame } = world.render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: fromScratch, regionScrollUsable: regionScroll })
  world.frames = [frame, front]
  return frame.screen
}
const rowOf = (screen: Screen, y: number): string => Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)?.char || ' ').join('').trimEnd()
function difference(live: Screen, fresh: Screen): string | null {
  if (live.width !== fresh.width || live.height !== fresh.height) return `size ${live.width}x${live.height} against ${fresh.width}x${fresh.height}`
  let cells = 0
  let first = -1
  for (let at = 0; at < live.width * live.height * 2; at += 2) {
    if (live.cells[at] === fresh.cells[at] && live.cells[at + 1] === fresh.cells[at + 1]) continue
    cells++
    if (first < 0) first = at >> 1
  }
  if (first < 0) return null
  const y = Math.floor(first / live.width)
  return `${cells} cells differ, first in row ${y}: reused ${JSON.stringify(rowOf(live, y))} · from scratch ${JSON.stringify(rowOf(fresh, y))}`
}

const GROUND = '#101820'

section('§1 a card that climbs one row onto the pane above it paints one way')
{
  const COLS = 40
  const ROWS = 12
  type Card = World & { paneLine: DOMElement; railLine: DOMElement; answer: DOMElement; clock: DOMElement; card: DOMElement; host: DOMElement; ground: DOMElement }
  const build = (ctx: ComposeContext, ground: string | undefined, rule: string): Card => {
    const root = createNode('ink-root')
    applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
    const paneLine = text('the pane')
    const railLine = text('rail')
    const row = box({ flexDirection: 'row', width: COLS, height: 6, overflow: 'hidden' }, [box({ borderStyle: 'round', width: 12, height: 6 }, [railLine]), box({ borderStyle: 'round', flexGrow: 1, height: 6 }, [paneLine])])
    const answer = text('1. Redis')
    const card = box({ marginTop: -1, width: COLS }, [text(rule), answer])
    const host = box({ width: COLS }, [card])
    const clock = text('12:00')
    const groundBox = box({ width: COLS, height: ROWS, ...(ground ? { backgroundColor: ground as never } : {}) }, [row, host, clock])
    appendChildNode(root, groundBox)
    return { root, render: createRenderer(root, ctx.stylePool), frames: [emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)], paneLine, railLine, answer, clock, card, host, ground: groundBox }
  }
  const steps: Array<[string, (w: Card) => void]> = [
    ['the first paint', () => {}],
    ['the clock ticks', w => retext(w.clock, '12:01')],
    ['the rail under the card changes', w => retext(w.railLine, 'rail 2')],
    ['the pane under the card changes', w => retext(w.paneLine, 'the pane, again')],
    ['the card\'s answer changes', w => retext(w.answer, '2. Postgres')],
    ['nothing changes', () => {}],
    ['the card steps down off the pane', w => applySceneStyle(w.card, { marginTop: 0, width: COLS })],
    ['the pane changes with the card below it', w => retext(w.paneLine, 'the pane')],
    ['the card climbs back', w => applySceneStyle(w.card, { marginTop: -1, width: COLS })],
    ['the clock ticks again', w => retext(w.clock, '12:02')],
    ['the card closes', w => removeChildNode(w.ground, w.host)],
    ['the pane changes with no card', w => retext(w.paneLine, 'the pane, alone')],
  ]
  for (const [name, ground, rule] of [['no ground, a rule across the row', undefined, '─'.repeat(COLS)], ['no ground, a short rule', undefined, '── a question'], ['a ground, a rule across the row', GROUND, '─'.repeat(COLS)]] as const) {
    const ctx = makeContext()
    const live = build(ctx, ground, rule)
    const fresh = build(ctx, ground, rule)
    const wrong: string[] = []
    let ruleRows = 0
    for (const [step, apply] of steps) {
      apply(live)
      apply(fresh)
      const reused = paint(live, COLS, ROWS, false, false)
      const diff = difference(reused, paint(fresh, COLS, ROWS, true, false))
      if (diff !== null) wrong.push(`${step}: ${diff}`)
      if (rowOf(reused, 5).startsWith(rule.slice(0, 12))) ruleRows++
    }
    check(`${name}: every frame of ${steps.length} equals the frame painted from scratch`, wrong.length === 0, `${wrong.length} differ; ${wrong[0]}`)
    check(`${name}: the scene holds the card's rule on the pane's border row while the card is up and climbs (${ruleRows} frames)`, ruleRows === 8, `${ruleRows} frames`)
  }
}

section('§2 seeded walks of a cockpit-shaped tree: what reuse composes equals what a paint from scratch composes')
{
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
  function item(words: string, bubble: string | undefined): Item {
    const line = text(words)
    return bubble === undefined ? { el: line, text: line, bubble: false } : { el: box({ backgroundColor: bubble as never, paddingLeft: 1, paddingRight: 1, flexDirection: 'row' }, [line]), text: line, bubble: true }
  }
  function build(ctx: ComposeContext, shape: Shape, ground: string | undefined): Tree {
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
    const items = Array.from({ length: rows + 12 }, (_, i) => item(`line ${String(i).padStart(2, '0')} · steady prose that stays`, i % 9 === 4 ? COLOURS[2] : undefined))
    const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: '100%' }, items.map(entry => entry.el))
    const transcript = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 0, overflowX: 'scroll', overflowY: 'scroll', paddingTop: shape.paddingTop }, [content])
    setAttribute(transcript, 'stickyScroll', true)
    const centre = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, overflow: 'hidden' }, [band, transcript])
    const row = box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, minHeight: 0, overflow: 'hidden' }, shape.withRail ? [rail, centre] : [centre])
    const footer = text('Type a prompt')
    const footerRow = box({ flexDirection: 'row', width: cols }, [footer])
    const groundBox = box({ width: cols, height: rows, overflow: 'hidden', ...(ground ? { backgroundColor: ground as never } : {}) }, [row, footerRow])
    appendChildNode(root, groundBox)
    return { root, render: createRenderer(root, ctx.stylePool), frames: [emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool), emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)], ground: groundBox, capsule, rail, railLines, spinner, label, timer, transcript, content, items, footer, footerRow, card: null }
  }

  const CHROME = ['rest', 'spinner', 'label', 'timer', 'rail-line', 'footer', 'border', 'rail-toggle']
  const CARD = ['card-open', 'card-answer', 'card-margin', 'card-close']
  const PANE = ['item-text', 'item-lines', 'append', 'remove', 'insert', 'scroll', 'scroll-end', 'bubble-colour']
  const WEIGHTS: Record<string, number> = { rest: 4, spinner: 10, label: 6, timer: 6, 'rail-line': 4, footer: 3, border: 2, 'rail-toggle': 2, 'card-open': 3, 'card-answer': 5, 'card-margin': 3, 'card-close': 2, 'item-text': 8, 'item-lines': 4, append: 6, remove: 3, insert: 3, scroll: 8, 'scroll-end': 2, 'bubble-colour': 3 }

  function next(rand: () => number, model: Model, shape: Shape, kinds: readonly string[]): Step {
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
    const words = (n: number): string => Array.from({ length: n }, () => pick(WORDS)).join(' ')
    const usable = kinds.filter(kind => (kind !== 'rail-line' && kind !== 'rail-toggle' || shape.withRail) && (kind !== 'remove' || model.items > 8) && (kind !== 'card-open' || !model.card) && (!['card-answer', 'card-margin', 'card-close'].includes(kind) || model.card))
    let roll = rand() * usable.reduce((n, kind) => n + WEIGHTS[kind]!, 0)
    let kind = usable[0]!
    for (const candidate of usable) {
      if (roll < WEIGHTS[candidate]!) {
        kind = candidate
        break
      }
      roll -= WEIGHTS[candidate]!
    }
    switch (kind) {
      case 'spinner': { const glyph = pick(['✹', '✺', '✶', '·']); return { kind, say: `the spinner ${glyph}`, apply: t => retext(t.spinner, glyph) } }
      case 'label': { const said = `${words(int(1, 3))}…`; return { kind, say: `the label "${said}"`, apply: t => retext(t.label, said) } }
      case 'timer': { const said = `(${int(1, 120)}s)`; return { kind, say: `the timer ${said}`, apply: t => retext(t.timer, said) } }
      case 'rail-line': { const at = int(0, 3); const said = words(int(0, 2)); return { kind, say: `rail line ${at} "${said}"`, apply: t => retext(t.railLines[at]!, said) } }
      case 'footer': { const said = words(int(1, 6)); return { kind, say: `the footer "${said}"`, apply: t => retext(t.footer, said) } }
      case 'border': { model.border = !model.border; const on = model.border; return { kind, say: `the capsule's border ${on ? 'on' : 'off'}`, apply: t => applySceneStyle(t.capsule, on ? { flexDirection: 'row', borderStyle: 'round', flexGrow: 1 } : { flexDirection: 'row', flexGrow: 1 }) } }
      case 'rail-toggle': { model.railShown = !model.railShown; const on = model.railShown; return { kind, say: `the rail ${on ? 'shown' : 'hidden'}`, apply: t => applySceneStyle(t.rail, { width: 14, overflow: 'hidden', display: on ? 'flex' : 'none' }) } }
      case 'item-text': { const at = int(0, model.items - 1); const said = words(int(0, 9)); return { kind, say: `item ${at} "${said}"`, apply: t => retext(t.items[at]!.text, said) } }
      case 'item-lines': { const at = int(Math.max(0, model.items - 6), model.items - 1); const said = Array.from({ length: int(1, 4) }, () => words(int(1, 5))).join('\n'); return { kind, say: `item ${at} becomes ${said.split('\n').length} lines`, apply: t => retext(t.items[at]!.text, said) } }
      case 'append': { const said = words(int(1, 8)); const bubble = rand() < 0.2 ? pick(COLOURS) : undefined; model.items++; model.bubbles.push(bubble !== undefined); return { kind, say: `a row appended "${said}"`, apply: t => { const entry = item(said, bubble); t.items.push(entry); appendChildNode(t.content, entry.el) } } }
      case 'remove': { const at = int(0, model.items - 1); model.items--; model.bubbles.splice(at, 1); return { kind, say: `item ${at} removed`, apply: t => removeChildNode(t.content, t.items.splice(at, 1)[0]!.el) } }
      case 'insert': { const at = int(0, model.items - 1); const said = words(int(1, 8)); model.items++; model.bubbles.splice(at, 0, false); return { kind, say: `a row inserted before item ${at}`, apply: t => { const entry = item(said, undefined); insertBeforeNode(t.content, entry.el, t.items[at]!.el); t.items.splice(at, 0, entry) } } }
      case 'scroll': { const delta = pick([-1, -1, -2, -3, -5, -9, 1, 1, 2, 3, 5, 9, -40]); return { kind, say: `a scroll by ${delta}`, apply: t => { const scroll = (t.transcript.scroll ??= {}); scroll.pendingScrollDelta = (scroll.pendingScrollDelta ?? 0) + delta; scroll.stickyScroll = false; markDirty(t.transcript) } } }
      case 'scroll-end': return { kind, say: 'a scroll to the end', apply: t => { (t.transcript.scroll ??= {}).pendingScrollDelta = 9999; markDirty(t.transcript) } }
      case 'bubble-colour': { const held = model.bubbles.map((bubble, at) => (bubble ? at : -1)).filter(at => at >= 0); if (held.length === 0) return { kind: 'rest', say: 'nothing changes', apply: () => {} }; const at = pick(held); const colour = rand() < 0.3 ? undefined : pick(COLOURS); return { kind, say: `bubble ${at} ${colour ?? 'loses its ground'}`, apply: t => applySceneStyle(t.items[at]!.el, { ...(colour ? { backgroundColor: colour as never } : {}), paddingLeft: 1, paddingRight: 1, flexDirection: 'row' }) } }
      case 'card-open': { model.card = true; const margin = pick([-1, -1, -2, 0]); const whole = rand() < 0.5; return { kind, say: `a card opens (marginTop ${margin}, ${whole ? 'a rule across the row' : 'a short rule'})`, apply: (t, s) => { const answer = text('1. Redis'); const card = box({ marginTop: margin, width: s.cols }, [text(whole ? '─'.repeat(s.cols) : '── a question'), answer]); const host = box({ width: s.cols }, [card]); t.card = { host, card, answer }; insertBeforeNode(t.ground, host, t.footerRow) } } }
      case 'card-answer': { const said = `${int(1, 4)}. ${words(int(1, 3))}`; return { kind, say: `the card's answer "${said}"`, apply: t => retext(t.card!.answer, said) } }
      case 'card-margin': { const margin = pick([-2, -1, 0]); return { kind, say: `the card's top margin ${margin}`, apply: (t, s) => applySceneStyle(t.card!.card, { marginTop: margin, width: s.cols }) } }
      case 'card-close': { model.card = false; return { kind, say: 'the card closes', apply: t => { removeChildNode(t.ground, t.card!.host); t.card = null } } }
    }
    return { kind: 'rest', say: 'nothing changes', apply: () => {} }
  }

  const SHAPES: Shape[] = [
    { name: '96x24 with a rail', cols: 96, rows: 24, withRail: true, regionScroll: false, paddingTop: 1 },
    { name: '120x44 full width', cols: 120, rows: 44, withRail: false, regionScroll: true, paddingTop: 0 },
    { name: '80x20 with a rail', cols: 80, rows: 20, withRail: true, regionScroll: true, paddingTop: 1 },
  ]
  const WALKS: Array<{ name: string; ground: string | undefined; kinds: string[] }> = [
    { name: 'under a ground: the chrome, a card, the pane\'s rows and its scroll', ground: GROUND, kinds: [...CHROME, ...CARD, ...PANE] },
    { name: 'no ground: the chrome and a card over a pane at rest', ground: undefined, kinds: [...CHROME, ...CARD] },
  ]
  for (const walk of WALKS) {
    for (const shape of SHAPES) {
      const wrong: string[] = []
      let frames = 0
      for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed++) {
        const rand = prng(seed * 7919 + shape.cols)
        const ctx = makeContext()
        const live = build(ctx, shape, walk.ground)
        const fresh = build(ctx, shape, walk.ground)
        const model: Model = { items: live.items.length, bubbles: live.items.map(entry => entry.bubble), railShown: true, border: true, card: false }
        paint(live, shape.cols, shape.rows, false, shape.regionScroll)
        paint(fresh, shape.cols, shape.rows, true, shape.regionScroll)
        const trail: string[] = []
        for (let step = 0; step < STEPS; step++) {
          const move = next(rand, model, shape, walk.kinds)
          trail.push(move.say)
          if (live.transcript.scroll) fresh.transcript.scroll = { ...live.transcript.scroll }
          move.apply(live, shape)
          move.apply(fresh, shape)
          const reused = paint(live, shape.cols, shape.rows, false, shape.regionScroll)
          const diff = difference(reused, paint(fresh, shape.cols, shape.rows, true, shape.regionScroll))
          frames++
          if (diff === null) continue
          wrong.push(`seed ${seed}, step ${step} (${move.say}): ${diff}; before it: ${trail.slice(-5, -1).join(' → ')}`)
          break
        }
      }
      check(`${walk.name} · ${shape.name}: ${SEEDS} walks of ${STEPS} steps, every frame equals the frame painted from scratch (${frames} frames)`, wrong.length === 0, `${wrong.length} walks differ; ${wrong[0]}`)
    }
  }
}

console.log(failures === 0 ? `\n✅ ALL ${checks} REUSE CHECKS PASS` : `\n❌ ${failures} of ${checks} REUSE CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
