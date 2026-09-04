#!/usr/bin/env bun
import {
  appendChildNode,
  createNode,
  createTextNode,
  type DOMElement,
  markDirty,
  setTextNodeValue,
  type TextNode,
} from '../../src/ink/dom.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import createRenderer from '../../src/ink/renderer.js'
import type { ComposeSignals } from '../../src/ink/compose-walk.js'
import { lastComposeCounts } from '../../src/ink/compose-buffer.js'
import {
  type Cell,
  CellWidth,
  cellAt,
  CharPool,
  HyperlinkPool,
  type Screen,
  StylePool,
} from '../../src/ink/cell-grid.js'
import type { Styles } from '../../src/ink/styles.js'
import { FrameWriter } from '../../src/ink/frame-writer.js'
import { OverlayRecord } from '../../src/ink/geometry/overlay.js'
import {
  clearSelection,
  createSelectionState,
  type SelectionState,
  startSelection,
  updateSelection,
} from '../../src/ink/geometry/selection.js'
import { unionRect } from '../../src/ink/layout/geometry.js'
import { optimizePatches } from '../../src/ink/patch-stream.js'
import { applyOverlayPass } from '../../src/ink/root/overlay-pass.js'
import { writeDiffToTerminal } from '../../src/ink/session/delivery.js'
import { CURSOR_HOME } from '../../src/ink/termio/csi.js'
import { AnsiEmulator, defaultSgr, sgrStateOfStyleString, type SgrState } from '../ink-runtime/ansiEmulator.js'
import { applySceneStyle } from '../ink-runtime/frameHarness.js'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const COLS = 30
const ROWS = 12

class ComposeSession {
  readonly stylePool = new StylePool()
  readonly charPool = new CharPool()
  readonly hyperlinkPool = new HyperlinkPool()
  private front: Frame
  private back: Frame
  private readonly render: ReturnType<typeof createRenderer>

  constructor(readonly root: DOMElement) {
    this.front = emptyFrame(ROWS, COLS, this.stylePool, this.charPool, this.hyperlinkPool)
    this.back = emptyFrame(ROWS, COLS, this.stylePool, this.charPool, this.hyperlinkPool)
    this.render = createRenderer(root, this.stylePool)
  }

  step(): { frame: Frame; counts: typeof lastComposeCounts; signals: ComposeSignals } {
    this.root.layoutNode!.calculateLayout(COLS, ROWS)
    const { frame, signals } = this.render({
      frontFrame: this.front,
      backFrame: this.back,
      isTTY: true,
      terminalWidth: COLS,
      terminalRows: ROWS,
      altScreen: true,
      prevFrameContaminated: false,
      regionScrollUsable: true,
    })
    this.back = this.front
    this.front = frame
    return { frame, counts: { ...lastComposeCounts }, signals }
  }
}

function decode(screen: Screen, pool: StylePool): string {
  const rows: Array<Array<[string, string, string | null]>> = []
  for (let y = 0; y < screen.height; y++) {
    const row: Array<[string, string, string | null]> = []
    for (let x = 0; x < screen.width; x++) {
      const c: Cell | undefined = cellAt(screen, x, y)
      if (!c || c.width === CellWidth.SpacerTail) {
        row.push([c ? '' : ' ', '', null])
        continue
      }
      row.push([c.char, pool.transition(pool.none, c.styleId), c.hyperlink ?? null])
    }
    rows.push(row)
  }
  return JSON.stringify(rows)
}

type TreeSpec = {
  lines: Array<{ text: string; style?: Styles }>
  boxStyle?: Styles
}

function buildTree(spec: TreeSpec): { root: DOMElement; texts: TextNode[]; box: DOMElement } {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
  const box = createNode('ink-box')
  applySceneStyle(box, {
    flexDirection: 'column',
    flexGrow: 0,
    flexShrink: 1,
    ...spec.boxStyle,
  })
  const texts: TextNode[] = []
  for (const line of spec.lines) {
    const t = createNode('ink-text')
    if (line.style) applySceneStyle(t, line.style)
    const tn = createTextNode(line.text)
    appendChildNode(t, tn as never)
    texts.push(tn)
    appendChildNode(box, t)
  }
  appendChildNode(root, box)
  return { root, texts, box }
}

function freshCompose(spec: TreeSpec): { screen: Screen; pool: StylePool } {
  const { root } = buildTree(spec)
  const session = new ComposeSession(root)
  const { frame } = session.step()
  return { screen: frame.screen, pool: session.stylePool }
}

function checkEquivalence(label: string, session: ComposeSession, frame: Frame, spec: TreeSpec): void {
  const fresh = freshCompose(spec)
  check(
    `${label}: incremental ≡ fresh`,
    decode(frame.screen, session.stylePool) === decode(fresh.screen, fresh.pool),
  )
}

console.log('native-core T3 — frame composition contract (live-tree journeys)')

{
  const spec: TreeSpec = {
    lines: [
      { text: 'alpha row one', style: { color: 'red', bold: true } },
      { text: 'beta row two' },
      { text: 'gamma 漢字 three', style: { backgroundColor: '#112233' } },
      { text: 'delta four' },
    ],
    boxStyle: { borderStyle: 'round' },
  }
  const { root, texts } = buildTree(spec)
  const session = new ComposeSession(root)

  const first = session.step()
  check('first frame writes content', first.counts.write > 0, `write=${first.counts.write}`)
  checkEquivalence('first frame', session, first.frame, spec)

  const steady = session.step()
  check('steady-state: zero written cells', steady.counts.write === 0, `write=${steady.counts.write}`)
  check('steady-state: blit engaged', steady.counts.blit > 0, `blit=${steady.counts.blit}`)
  check('steady-state: no layout shift', !steady.frame.scrollHint && steady.counts.write === 0)
  checkEquivalence('steady state', session, steady.frame, spec)

  spec.lines[1]!.text = 'BETA ROW TWO'
  setTextNodeValue(texts[1]!, 'BETA ROW TWO')
  const dirty = session.step()
  const boxArea = COLS * 6
  check(
    'dirty-narrow: writes bounded to the dirty box',
    dirty.counts.write > 0 && dirty.counts.write <= boxArea,
    `write=${dirty.counts.write} bound=${boxArea}`,
  )
  check('dirty-narrow: siblings still blit', dirty.counts.blit > 0, `blit=${dirty.counts.blit}`)
  checkEquivalence('dirty-narrow', session, dirty.frame, spec)

  const longText = 'epsilon grows past the box width so it wraps'
  spec.lines[1]!.text = longText
  setTextNodeValue(texts[1]!, longText)
  const grown = session.step()
  checkEquivalence('growth reflow', session, grown.frame, spec)

  spec.lines[1]!.text = 'short again'
  setTextNodeValue(texts[1]!, 'short again')
  const shrunk = session.step()
  checkEquivalence('shrink reflow', session, shrunk.frame, spec)
}

type ScrollSpec = {
  items: string[]
  fullWidth: boolean
  sticky?: boolean
}

function buildScrollTree(spec: ScrollSpec): {
  root: DOMElement
  scrollBox: DOMElement
  content: DOMElement
} {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
  const row = createNode('ink-box')
  applySceneStyle(row, { flexDirection: 'row', flexGrow: 0, flexShrink: 1 })
  if (!spec.fullWidth) {
    const rail = createNode('ink-box')
    applySceneStyle(rail, { width: 8, flexDirection: 'column', flexGrow: 0, flexShrink: 0 })
    const railText = createNode('ink-text')
    appendChildNode(railText, createTextNode('RAIL') as never)
    appendChildNode(rail, railText)
    appendChildNode(row, rail)
  }
  const scrollBox = createNode('ink-box')
  applySceneStyle(scrollBox, {
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    height: ROWS,
    overflowY: 'scroll',
  })
  if (spec.sticky) scrollBox.attributes['stickyScroll'] = true
  const content = createNode('ink-box')
  applySceneStyle(content, { flexDirection: 'column', flexGrow: 0, flexShrink: 0 })
  for (const item of spec.items) {
    const t = createNode('ink-text')
    appendChildNode(t, createTextNode(item) as never)
    appendChildNode(content, t)
  }
  appendChildNode(scrollBox, content)
  appendChildNode(row, scrollBox)
  appendChildNode(root, row)
  return { root, scrollBox, content }
}

function freshScrollCompose(spec: ScrollSpec, scrollTop: number): { screen: Screen; pool: StylePool } {
  const t = buildScrollTree(spec)
  ;(t.scrollBox.scroll ??= {}).scrollTop = scrollTop
  const session = new ComposeSession(t.root)
  const { frame } = session.step()
  return { screen: frame.screen, pool: session.stylePool }
}

{
  const spec: ScrollSpec = {
    items: Array.from({ length: 30 }, (_, i) => `item ${String(i).padStart(2, '0')} content`),
    fullWidth: true,
  }
  const t = buildScrollTree(spec)
  const session = new ComposeSession(t.root)
  session.step()
  session.step()

  ;(t.scrollBox.scroll ??= {}).pendingScrollDelta = 4
  markDirty(t.scrollBox)
  const scrolled = session.step()
  const applied = t.scrollBox.scroll?.scrollTop ?? 0
  check('full-width scroll applied rows', applied > 0, `scrollTop=${applied}`)
  check(
    'full-width scroll publishes a DECSTBM hint',
    scrolled.frame.scrollHint !== null &&
      scrolled.frame.scrollHint !== undefined &&
      scrolled.frame.scrollHint.delta === applied,
    JSON.stringify(scrolled.frame.scrollHint ?? null),
  )
  {
    const fresh = freshScrollCompose(spec, applied)
    check(
      'full-width scroll: incremental ≡ fresh',
      decode(scrolled.frame.screen, session.stylePool) === decode(fresh.screen, fresh.pool),
    )
  }

  const paneSpec: ScrollSpec = {
    items: Array.from({ length: 30 }, (_, i) => `row ${String(i).padStart(2, '0')}`),
    fullWidth: false,
  }
  const p = buildScrollTree(paneSpec)
  const paneSession = new ComposeSession(p.root)
  paneSession.step()
  paneSession.step()
  ;(p.scrollBox.scroll ??= {}).pendingScrollDelta = 4
  markDirty(p.scrollBox)
  const paneScrolled = paneSession.step()
  const paneApplied = p.scrollBox.scroll?.scrollTop ?? 0
  check('pane scroll applied rows', paneApplied > 0, `scrollTop=${paneApplied}`)
  check(
    'pane scroll publishes NO DECSTBM hint (rail-drag law)',
    paneScrolled.frame.scrollHint == null,
    JSON.stringify(paneScrolled.frame.scrollHint ?? null),
  )
  {
    const fresh = freshScrollCompose(paneSpec, paneApplied)
    check(
      'pane scroll: incremental ≡ fresh',
      decode(paneScrolled.frame.screen, paneSession.stylePool) === decode(fresh.screen, fresh.pool),
    )
  }
}

{
  const spec: ScrollSpec = {
    items: Array.from({ length: 20 }, (_, i) => `line ${i}`),
    fullWidth: true,
    sticky: true,
  }
  const t = buildScrollTree(spec)
  const session = new ComposeSession(t.root)
  session.step()
  const beforeTop = t.scrollBox.scroll?.scrollTop ?? 0
  check('sticky start: pinned at max', beforeTop > 0, `scrollTop=${beforeTop}`)

  const nt = createNode('ink-text')
  appendChildNode(nt, createTextNode('appended tail line') as never)
  appendChildNode(t.content, nt)
  const grown = session.step()
  const afterTop = t.scrollBox.scroll?.scrollTop ?? 0
  check('sticky growth: follows to the new max', afterTop === beforeTop + 1, `${beforeTop}→${afterTop}`)
  const follow = grown.signals.consumeFollowScroll()
  check(
    'sticky growth: followScroll published once',
    follow !== null && follow.delta === afterTop - beforeTop,
    JSON.stringify(follow),
  )
  check('followScroll consumed', grown.signals.consumeFollowScroll() === null)
}

{
  const spec: ScrollSpec = {
    items: Array.from({ length: 40 }, (_, i) => `hold ${String(i).padStart(2, '0')}`),
    fullWidth: true,
  }
  const t = buildScrollTree(spec)
  const session = new ComposeSession(t.root)
  session.step()
  session.step()

  const sc = (t.scrollBox.scroll ??= {})
  sc.scrollTop = 2
  sc.scrollClampMin = 10
  sc.scrollClampMax = 30
  markDirty(t.scrollBox)
  const held = session.step()
  check('clamp-hold: intent survives the bound-held paint', sc.scrollTop === 2, `scrollTop=${sc.scrollTop}`)
  check('clamp-hold: the held paint requests a follow-up drain', held.frame.scrollDrainPending === true)

  markDirty(t.scrollBox)
  const quiet = session.step()
  check('clamp-hold: an unchanged gap requests nothing', quiet.frame.scrollDrainPending !== true)

  sc.scrollClampMin = 6
  markDirty(t.scrollBox)
  const advanced = session.step()
  check('clamp-hold: moved bounds re-request the drain', advanced.frame.scrollDrainPending === true)

  sc.scrollClampMin = 0
  markDirty(t.scrollBox)
  const covered = session.step()
  check('clamp-hold: covering bounds end the chain', covered.frame.scrollDrainPending !== true)
  check('clamp-hold: the covered paint sits at the intent', sc.scrollTop === 2, `scrollTop=${sc.scrollTop}`)
}

const SELECTION_BG = '48;2;40;60;90'

function serialize(diff: ReturnType<typeof optimizePatches>): string {
  let captured = ''
  const fake = {
    stdout: {
      write(s: string) {
        captured += s
        return true
      },
      isTTY: false,
    },
  }
  writeDiffToTerminal(fake as never, diff, false)
  return captured
}

class OverlaySession {
  readonly stylePool = new StylePool()
  readonly charPool = new CharPool()
  readonly hyperlinkPool = new HyperlinkPool()
  readonly selection: SelectionState = createSelectionState()
  readonly emu = new AnsiEmulator(COLS, ROWS, true)
  searchQuery = ''
  private front: Frame
  private back: Frame
  private glass: OverlayRecord | null = null
  private readonly render: ReturnType<typeof createRenderer>
  private readonly writer: FrameWriter

  constructor(readonly root: DOMElement) {
    this.stylePool.setSelectionBg({ code: `\x1b[${SELECTION_BG}m`, endCode: '\x1b[49m' })
    this.front = emptyFrame(ROWS, COLS, this.stylePool, this.charPool, this.hyperlinkPool)
    this.back = emptyFrame(ROWS, COLS, this.stylePool, this.charPool, this.hyperlinkPool)
    this.render = createRenderer(root, this.stylePool)
    this.writer = new FrameWriter({ isTTY: true, stylePool: this.stylePool })
  }

  step(): { frame: Frame; counts: typeof lastComposeCounts; bytes: string } {
    this.root.layoutNode!.calculateLayout(COLS, ROWS)
    const glass = this.glass
    if (glass) glass.revert(this.front.screen)
    const { frame, signals } = this.render({
      frontFrame: this.front,
      backFrame: this.back,
      isTTY: true,
      terminalWidth: COLS,
      terminalRows: ROWS,
      altScreen: true,
      prevFrameContaminated: false,
      regionScrollUsable: true,
    })
    if (glass) glass.restore(this.front.screen)
    const counts = { ...lastComposeCounts }
    const record = new OverlayRecord(frame.screen.width)
    applyOverlayPass({
      altScreen: true,
      follow: signals.consumeFollowScroll(),
      selection: this.selection,
      captureScreen: this.front.screen,
      screen: frame.screen,
      stylePool: this.stylePool,
      searchQuery: this.searchQuery,
      searchPositions: null,
      onSelectionCleared: () => {},
      record,
    })
    const vacated = glass ? glass.rect() : null
    if (vacated) {
      frame.screen.damage = frame.screen.damage ? unionRect(frame.screen.damage, vacated) : vacated
    }
    const anchored: Frame = { ...this.front, cursor: { x: 0, y: 0, visible: false } }
    const bytes = serialize(optimizePatches(this.writer.render(anchored, frame, true, true)))
    this.emu.feed(CURSOR_HOME + bytes)
    this.back = this.front
    this.front = frame
    this.glass = record.size > 0 ? record : null
    return { frame, counts, bytes }
  }
}

function expectedStyle(pool: StylePool, styleId: number): SgrState {
  return sgrStateOfStyleString(pool.transition(pool.none, styleId))
}

function sameVisibleStyle(char: string, actual: SgrState | null, expected: SgrState): boolean {
  const a = actual ?? defaultSgr()
  if (char === ' ') {
    return (
      a.bg === expected.bg &&
      a.inverse === expected.inverse &&
      a.underline === expected.underline &&
      a.strike === expected.strike
    )
  }
  return (
    a.bold === expected.bold &&
    a.dim === expected.dim &&
    a.italic === expected.italic &&
    a.underline === expected.underline &&
    a.inverse === expected.inverse &&
    a.strike === expected.strike &&
    a.fg === expected.fg &&
    a.bg === expected.bg
  )
}

function glassMismatch(emu: AnsiEmulator, frame: Frame, pool: StylePool): string {
  const { screen } = frame
  for (let y = 0; y < screen.height; y++) {
    for (let x = 0; x < screen.width; x++) {
      const cell = cellAt(screen, x, y)
      const got = emu.grid[y]![x]!
      const style = emu.styleAt(x, y)
      if (!cell) {
        if (got !== ' ') return `(${x},${y}) text: glass ${JSON.stringify(got)} vs an empty cell`
        if (style && (style.bg !== 'default' || style.inverse)) {
          return `(${x},${y}) style: glass ${JSON.stringify(style)} vs an empty cell`
        }
        continue
      }
      if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
      const want = cell.char === '' ? ' ' : cell.char
      if (got !== want) return `(${x},${y}) text: glass ${JSON.stringify(got)} vs frame ${JSON.stringify(want)}`
      const exp = expectedStyle(pool, cell.styleId)
      if (!sameVisibleStyle(cell.char, style, exp)) {
        return `(${x},${y}) style ${JSON.stringify(cell.char)}: glass ${JSON.stringify(style)} vs frame ${JSON.stringify(exp)}`
      }
    }
  }
  return ''
}

function glassSnapshot(emu: AnsiEmulator): string[] {
  const out: string[] = []
  for (let y = 0; y < emu.height; y++) {
    for (let x = 0; x < emu.width; x++) {
      out.push(`${emu.grid[y]![x]}|${JSON.stringify(emu.styleAt(x, y))}`)
    }
  }
  return out
}

function highlightedCells(emu: AnsiEmulator): Set<number> {
  const out = new Set<number>()
  for (let y = 0; y < emu.height; y++) {
    for (let x = 0; x < emu.width; x++) {
      if (emu.styleAt(x, y)?.bg === SELECTION_BG) out.add(y * emu.width + x)
    }
  }
  return out
}

function freshOverlay(spec: TreeSpec, like: OverlaySession): { screen: Screen; pool: StylePool } {
  const { root } = buildTree(spec)
  const s = new OverlaySession(root)
  const sel = like.selection
  s.selection.anchor = sel.anchor ? { ...sel.anchor } : null
  s.selection.focus = sel.focus ? { ...sel.focus } : null
  s.selection.isDragging = sel.isDragging
  s.selection.clipLo = sel.clipLo
  s.selection.clipHi = sel.clipHi
  s.searchQuery = like.searchQuery
  return { screen: s.step().frame.screen, pool: s.stylePool }
}

function checkOverlayStep(
  label: string,
  session: OverlaySession,
  spec: TreeSpec,
  r: { frame: Frame; counts: typeof lastComposeCounts; bytes: string },
  steadyTree: boolean,
): void {
  const fresh = freshOverlay(spec, session)
  check(
    `${label}: incremental ≡ fresh (overlay included)`,
    decode(r.frame.screen, session.stylePool) === decode(fresh.screen, fresh.pool),
  )
  const mismatch = glassMismatch(session.emu, r.frame, session.stylePool)
  check(`${label}: the glass replays the frame cell-exact`, mismatch === '', mismatch)
  if (steadyTree) {
    check(
      `${label}: composes no text (the blit engaged)`,
      r.counts.write === 0 && r.counts.blit > 0,
      `write=${r.counts.write} blit=${r.counts.blit}`,
    )
  }
}

{
  const spec: TreeSpec = {
    lines: [
      { text: 'alpha row one', style: { color: 'red', bold: true } },
      { text: 'beta row two' },
      { text: 'gamma 漢字 three', style: { backgroundColor: '#112233' } },
      { text: 'delta four' },
    ],
    boxStyle: { borderStyle: 'round' },
  }
  const { root, texts } = buildTree(spec)
  const session = new OverlaySession(root)
  const sel = session.selection

  checkOverlayStep('overlay: first frame', session, spec, session.step(), false)
  session.step()

  startSelection(sel, 2, 1)
  updateSelection(sel, 8, 1)
  checkOverlayStep('overlay: grow on one row', session, spec, session.step(), true)
  updateSelection(sel, 5, 3)
  checkOverlayStep('overlay: grow across three rows (wide glyphs under it)', session, spec, session.step(), true)
  updateSelection(sel, 4, 2)
  checkOverlayStep('overlay: shrink', session, spec, session.step(), true)

  const still = session.step()
  checkOverlayStep('overlay: unchanged selection', session, spec, still, true)
  check('overlay: an unchanged selection writes zero bytes', still.bytes.length === 0, `${still.bytes.length} bytes`)

  sel.anchor = { col: 2, row: 2 }
  sel.focus = { col: 4, row: 3 }
  checkOverlayStep('overlay: move rows', session, spec, session.step(), true)

  spec.lines[1]!.text = 'BETA ROW TWO'
  setTextNodeValue(texts[1]!, 'BETA ROW TWO')
  const changed = session.step()
  checkOverlayStep('overlay: content change under the selection', session, spec, changed, false)
  check('overlay: the content change composed text', changed.counts.write > 0, `write=${changed.counts.write}`)

  session.searchQuery = 'row'
  checkOverlayStep('overlay: the search highlight joins the record', session, spec, session.step(), true)
  session.searchQuery = ''
  checkOverlayStep('overlay: the search highlight leaves', session, spec, session.step(), true)

  const highlighted = highlightedCells(session.emu)
  check('overlay: the glass carries the highlight before the clear', highlighted.size > 0, `${highlighted.size} cells`)
  const before = glassSnapshot(session.emu)
  clearSelection(sel)
  checkOverlayStep('overlay: clear', session, spec, session.step(), true)
  const after = glassSnapshot(session.emu)
  const changedCells = new Set<number>()
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changedCells.add(i)
  const exact = changedCells.size === highlighted.size && [...changedCells].every(i => highlighted.has(i))
  check(
    'overlay: the clear frame changes exactly the vacated cells',
    exact,
    `changed ${changedCells.size} vs highlighted ${highlighted.size}`,
  )
  const quiet = session.step()
  check(
    'overlay: steady after the clear writes zero bytes and composes no text',
    quiet.bytes.length === 0 && quiet.counts.write === 0,
    `${quiet.bytes.length} bytes, write=${quiet.counts.write}`,
  )
}

if (failures > 0) {
  console.log(`\nnative-core compose contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core compose contract: green (${checks} checks)`)
