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

if (failures > 0) {
  console.log(`\nnative-core compose contract: RED (${failures}/${checks} checks failed)`)
  process.exit(1)
}
console.log(`\nnative-core compose contract: green (${checks} checks)`)
