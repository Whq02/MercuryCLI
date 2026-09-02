#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-scroll-region-promise.ts — the region-scroll
//  PROMISE law (the duplicate-paint sighting on macOS).
//
//  THE CLASS: compose-walk's full-width scroll fast path blits the previous
//  region and shifts it in the model with the shifted rows EXCLUDED from
//  damage — sound ONLY because the writer will move those rows with a
//  DECSTBM region scroll. The writer performs that scroll only when the
//  terminal is capable (sync output + trusted region scroll); on Apple
//  Terminal (neither) and the conhost phantom lineage the writer takes the
//  plain diff, diffEach clips to the damage rect, the excluded rows are
//  never re-emitted, and the GLASS keeps the pre-scroll cells while fresh
//  paints land at the edge: the same reply standing at two or three offsets,
//  accumulating until a full repaint (the operator's every-other-message
//  duplicate transcript rows, receipts included; the capability comment in
//  session/capabilities.ts names the symptom family — "whole turns painted
//  twice").
//
//  THE LAW: the hint is a PROMISE, not a preference. composeTree mints a
//  full-width hint only when the caller promises the region scroll will be
//  emitted (RenderOptions.regionScrollUsable → ComposeOptions →
//  WalkCtx); without the promise the surface takes the rect-shift road —
//  same model blit, damage UNIONED, the diff re-emits. ink.tsx derives ONE
//  truth per frame and hands it to compose and writer alike.
//
//  §1 the capable road: promise given + region-scrolling writer — the hint
//     mints, replay is cell-exact, no text token paints twice.
//  §2 the coherence law at the source: the ink root derives ONE
//     regionScrollUsable per frame and hands it to compose AND writer —
//     the disagreement the class needs cannot be assembled from two
//     independent capability reads.
//  §3 the incapable road (the fix, red-first): promise withheld — NO hint
//     composes, the plain writer replays cell-exact, the census stays clean
//     across a settle-shaped commit sequence (collapse + retire + append +
//     slide). Pre-fix the option did not exist, the hint composed anyway,
//     and this section's first check reds.
//  §4 the rect road's re-emit guarantee: promise withheld — the composed
//     frame's damage covers the shifted region (diffEach can see it).
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-scroll-region-promise.ts
// ============================================================================
import {
  appendChildNode,
  createNode,
  createTextNode,
  insertBeforeNode,
  removeChildNode,
  setStyle,
  markDirty,
  type DOMElement,
} from '../../src/ink/dom.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import createRenderer from '../../src/ink/renderer.js'
import { CharPool, charInCellAt, HyperlinkPool, StylePool } from '../../src/ink/cell-grid.js'
import applyStyles, { type Styles } from '../../src/ink/styles.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { optimizePatches as optimize } from '../../src/ink/patch-stream.js'
import { CURSOR_HOME } from '../../src/ink/termio/csi.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { AnsiEmulator } from './ansiEmulator.js'

const W = 60
const H = 16

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  [PASS] ${label}`)
  else {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(title: string): void {
  console.log(`\n${title}`)
}

function styled(el: DOMElement, style: Styles): void {
  setStyle(el, style)
  if (el.layoutNode) applyStyles(el.layoutNode, style)
}
function box(style: Styles): DOMElement {
  const el = createNode('ink-box')
  styled(el, { flexDirection: 'row', flexGrow: 0, flexShrink: 1, ...style })
  return el
}
function item(id: string, lines: number): { el: DOMElement; texts: DOMElement[] } {
  const el = box({ flexDirection: 'column', width: '100%', flexShrink: 0 })
  const texts: DOMElement[] = []
  for (let i = 0; i < lines; i++) {
    const t = createNode('ink-text')
    appendChildNode(t, createTextNode(`[${id}#L${i}]`) as never)
    appendChildNode(el, t)
    texts.push(t)
  }
  return { el, texts }
}

function serializeDiff(diff: ReturnType<typeof optimize>): string {
  let captured = ''
  const fake = { stdout: { write(s: string) { captured += s; return true }, isTTY: false } }
  writeDiffToTerminal(fake as never, diff, false)
  return captured
}
function seedEmu(f: Frame): AnsiEmulator {
  const emu = new AnsiEmulator(f.screen.width, f.screen.height, true)
  for (let y = 0; y < f.screen.height; y++)
    for (let x = 0; x < f.screen.width; x++) emu.grid[y]![x] = charInCellAt(f.screen, x, y) || ' '
  return emu
}
function gridMismatch(emu: AnsiEmulator, f: Frame): string {
  for (let y = 0; y < f.screen.height; y++)
    for (let x = 0; x < f.screen.width; x++) {
      const want = charInCellAt(f.screen, x, y) || ' '
      const got = emu.grid[y]![x] || ' '
      if (want !== got) return `(${x},${y}): glass ${JSON.stringify(got)} vs frame ${JSON.stringify(want)}`
    }
  return ''
}
function glassDoubles(emu: AnsiEmulator): string[] {
  const counts = new Map<string, number>()
  const re = /\[it\d+#L\d+\]/g
  for (const row of emu.grid) {
    const line = row.join('')
    for (const m of line.matchAll(re)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1)
  }
  return [...counts].filter(([, n]) => n > 1).map(([t, n]) => `${t}x${n}`)
}

type World = {
  root: DOMElement
  scrollEl: DOMElement
  content: DOMElement
  items: { el: DOMElement; texts: DOMElement[] }[]
  tail: { el: DOMElement; texts: DOMElement[] }
  pool: StylePool
  render: ReturnType<typeof createRenderer>
  front: Frame
  charPool: CharPool
  linkPool: HyperlinkPool
}

function makeWorld(): World {
  const pool = new StylePool()
  const charPool = new CharPool()
  const linkPool = new HyperlinkPool()
  const root = createNode('ink-root')
  styled(root, { width: W, height: H, flexDirection: 'column' })
  const scrollEl = createNode('ink-box')
  styled(scrollEl, {
    flexDirection: 'row',
    flexGrow: 0,
    flexShrink: 1,
    overflowX: 'scroll',
    overflowY: 'scroll',
    alignItems: 'flex-start',
    height: H,
    width: W,
  })
  const content = box({ flexDirection: 'column', flexGrow: 1, flexShrink: 0, width: W })
  appendChildNode(scrollEl, content)
  appendChildNode(root, scrollEl)
  ;(scrollEl as unknown as { scroll: Record<string, unknown> }).scroll = { scrollTop: 0, stickyScroll: true }
  const items: World['items'] = []
  for (let i = 0; i < 8; i++) {
    const it = item(`it${i}`, 3)
    items.push(it)
    appendChildNode(content, it.el)
  }
  const tail = item('it90', 2)
  appendChildNode(content, tail.el)
  markDirty(content)
  return {
    root,
    scrollEl,
    content,
    items,
    tail,
    pool,
    render: createRenderer(root, pool),
    front: emptyFrame(H, W, pool, charPool, linkPool),
    charPool,
    linkPool,
  }
}

/** One committed frame through the production renderer (sticky pinned like
 *  the ScrollBox's bottom-follow), returning the composed result. */
function commit(w: World, promise: boolean, contaminated = false): { frame: Frame; prev: Frame; hint: boolean } {
  w.root.layoutNode!.calculateLayout(W, H)
  const contentH = Math.ceil(w.content.layoutNode!.getComputedHeight())
  const sc = (w.scrollEl as unknown as { scroll: { scrollTop: number; stickyScroll?: boolean } }).scroll
  if (sc.stickyScroll) sc.scrollTop = Math.max(0, contentH - H)
  const back = emptyFrame(H, W, w.pool, w.charPool, w.linkPool)
  const res = w.render({
    frontFrame: w.front,
    backFrame: back,
    isTTY: true,
    terminalWidth: W,
    terminalRows: H,
    altScreen: true,
    prevFrameContaminated: contaminated,
    regionScrollUsable: promise,
  })
  const prev = w.front
  w.front = res.frame
  return { frame: res.frame, prev, hint: res.frame.scrollHint != null }
}

/** The settle-shaped commit sequence (the sighting's cadence): stream tail
 *  grows, a tool round collapses, the tail retires into a settled reply +
 *  receipt, the window slides, the next message appends. Returns per-commit
 *  results. */
function driveSequence(w: World, promise: boolean): { frame: Frame; prev: Frame; hint: boolean }[] {
  const out: { frame: Frame; prev: Frame; hint: boolean }[] = []
  out.push(commit(w, promise, true))
  // settle: collapse it6 3→1, retire the tail, append settled+receipt
  const it6 = w.items[6]!
  removeChildNode(it6.el, it6.texts[1]!)
  removeChildNode(it6.el, it6.texts[2]!)
  markDirty(it6.el)
  removeChildNode(w.content, w.tail.el)
  const settled = item('it10', 2)
  const receipt = item('it11', 1)
  appendChildNode(w.content, settled.el)
  appendChildNode(w.content, receipt.el)
  markDirty(w.content)
  out.push(commit(w, promise))
  // next message streams
  const nxt = item('it12', 2)
  appendChildNode(w.content, nxt.el)
  markDirty(w.content)
  out.push(commit(w, promise))
  // virtual window slide: unmount two, grow a spacer by their height
  const spacer = box({ flexDirection: 'column', width: '100%', flexShrink: 0, height: 0 })
  insertBeforeNode(w.content, spacer, w.items[0]!.el)
  removeChildNode(w.content, w.items[0]!.el)
  removeChildNode(w.content, w.items[1]!.el)
  styled(spacer, { flexDirection: 'column', width: '100%', flexShrink: 0, height: 6 })
  markDirty(w.content)
  out.push(commit(w, promise))
  // slide + append together
  const nxt2 = item('it13', 3)
  appendChildNode(w.content, nxt2.el)
  removeChildNode(w.content, w.items[2]!.el)
  styled(spacer, { flexDirection: 'column', width: '100%', flexShrink: 0, height: 9 })
  markDirty(w.content)
  out.push(commit(w, promise))
  // interior shrink alone (a receipt collapse with nothing appending)
  const it7 = w.items[7]!
  removeChildNode(it7.el, it7.texts[2]!)
  markDirty(it7.el)
  out.push(commit(w, promise))
  // one more streamed append (the next reply's first lines)
  const nxt3 = item('it14', 2)
  appendChildNode(w.content, nxt3.el)
  markDirty(w.content)
  out.push(commit(w, promise))
  return out
}

/** Replay the writer's bytes for every commit through the oracle; return the
 *  first mismatch and any doubled tokens on the final glass. */
function replaySequence(
  seq: { frame: Frame; prev: Frame; hint: boolean }[],
  pool: StylePool,
  regionScrollAtWriter: boolean,
): { mismatch: string; doubles: string[] } {
  const writer = new FrameWriter({ isTTY: true, stylePool: pool })
  let emu: AnsiEmulator | null = null
  let mismatch = ''
  for (const step of seq) {
    if (emu === null) {
      emu = seedEmu(step.frame)
      continue
    }
    const anchored: Frame = { ...step.prev, cursor: { x: 0, y: 0, visible: step.prev.cursor.visible } }
    const diff = optimize(writer.render(anchored, step.frame, true, regionScrollAtWriter))
    if (diff.length > 0) emu.feed(CURSOR_HOME + serializeDiff(diff))
    if (mismatch === '') mismatch = gridMismatch(emu, step.frame)
  }
  return { mismatch, doubles: emu ? glassDoubles(emu) : [] }
}

// ── §1 the capable road: promise given, writer scrolls the region ───────────
section('§1 the capable road: the hint mints and the region scroll replays cell-exact')
{
  const w = makeWorld()
  const seq = driveSequence(w, true)
  check('a full-width scroll hint composed at least once', seq.some(s => s.hint))
  const { mismatch, doubles } = replaySequence(seq, w.pool, true)
  check('replay equality holds across every commit', mismatch === '', mismatch)
  check('no text token stands twice on the glass', doubles.length === 0, doubles.join(' '))
}

// ── §2 one predicate, both consumers (the coherence law at the source) ──────
section('§2 ink.tsx hands ONE region-scroll truth to compose and writer alike')
{
  // The desync class needs compose and writer to DISAGREE about the region
  // scroll (a hint composed damage-light, the scroll never emitted). Today
  // every frame's clears keep the damage wide enough that the plain diff
  // re-emits the region anyway — the gate must not RELY on that coincidence,
  // so the law is pinned at the source: the ink root derives ONE
  // regionScrollUsable per frame and hands it to this.renderer AND
  // this.writer.render — never two independent capability reads.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../../src/ink/ink.tsx', import.meta.url), 'utf8'),
  )
  check(
    'the renderer call carries regionScrollUsable',
    /this\.renderer\(\{[^}]*regionScrollUsable/s.test(src),
  )
  check(
    'the writer render rides the SAME predicate (no second capability read)',
    /this\.writer\.render\(baseFrame, frame, this\.altScreenActive, regionScrollUsable\)/.test(src),
  )
  check(
    'no stray decstbmSafe derivation remains beside the one truth',
    !/const decstbmSafe = syncOutputSupportedNow\(\)/.test(src),
  )
}

// ── §3 the incapable road: promise withheld — the fix ───────────────────────
section('§3 the incapable road (Apple Terminal shape): no hint, plain replay cell-exact')
{
  const w = makeWorld()
  const seq = driveSequence(w, false)
  check('NO full-width scroll hint composes without the promise', seq.every(s => !s.hint))
  const { mismatch, doubles } = replaySequence(seq, w.pool, false)
  check('plain replay equality holds across every commit', mismatch === '', mismatch)
  check('no text token stands twice on the glass', doubles.length === 0, doubles.join(' '))
}

// ── §4 the rect road re-emit guarantee: shifted rows join the damage ────────
section('§4 the rect road: promise withheld ⇒ the shifted region rides the damage rect')
{
  const w = makeWorld()
  const first = commit(w, false, true)
  void first
  const nxt = item('it20', 2)
  appendChildNode(w.content, nxt.el)
  markDirty(w.content)
  const step = commit(w, false)
  const damage = step.frame.screen.damage
  check('the commit reports damage', damage != null)
  if (damage) {
    // The sticky append scrolled the whole region; without the promise the
    // shifted rows must be walkable by diffEach — the damage rect reaches
    // the region's top.
    check(
      'the damage rect covers the shifted region top (diffEach can re-emit it)',
      damage.y === 0,
      `damage starts at row ${damage.y}`,
    )
  }
}

console.log(
  failures === 0
    ? '\n✅ SCROLL REGION PROMISE — the hint composes only where the scroll will be emitted; no road leaves a reply standing twice'
    : `\n❌ ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
