#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import {
  appendChildNode,
  createNode,
  createTextNode,
  markDirty,
  setTextNodeValue,
  type DOMElement,
  type TextNode,
} from '../../src/ink/dom.js'
import { emptyFrame, type Frame } from '../../src/ink/frame.js'
import { nodeCache } from '../../src/ink/node-cache.js'
import createRenderer from '../../src/ink/renderer.js'
import type { ComposeSignals } from '../../src/ink/compose-walk.js'
import { applySceneStyle, buildDom, makeContext, screenLines, type SceneNode } from './frameHarness.js'

const COLS = 30
const ROWS = 12

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

class Session {
  private readonly ctx = makeContext()
  private front: Frame
  private back: Frame
  private readonly render: ReturnType<typeof createRenderer>
  constructor(readonly root: DOMElement) {
    this.front = emptyFrame(ROWS, COLS, this.ctx.stylePool, this.ctx.charPool, this.ctx.hyperlinkPool)
    this.back = emptyFrame(ROWS, COLS, this.ctx.stylePool, this.ctx.charPool, this.ctx.hyperlinkPool)
    this.render = createRenderer(root, this.ctx.stylePool)
  }
  step(): { frame: Frame; signals: ComposeSignals } {
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
    return { frame, signals }
  }
}

function rootOf(children: SceneNode[]): DOMElement {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
  for (const child of children) appendChildNode(root, buildDom(child))
  return root
}

function textLine(text: string): DOMElement {
  const el = createNode('ink-text')
  appendChildNode(el, createTextNode(text) as never)
  return el
}

function scrollScene(count: number): { root: DOMElement; scrollBox: DOMElement; content: DOMElement; items: DOMElement[] } {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
  const header = createNode('ink-box')
  applySceneStyle(header, { height: 1, flexShrink: 0, flexDirection: 'column' })
  appendChildNode(header, textLine('HEADER'))
  const scrollBox = createNode('ink-box')
  applySceneStyle(scrollBox, { flexDirection: 'column', flexGrow: 0, flexShrink: 0, height: 10, overflowY: 'scroll' })
  const content = createNode('ink-box')
  applySceneStyle(content, { flexDirection: 'column', flexGrow: 0, flexShrink: 0 })
  const items: DOMElement[] = []
  for (let i = 0; i < count; i++) {
    const item = textLine(`item ${String(i).padStart(2, '0')}`)
    items.push(item)
    appendChildNode(content, item)
  }
  appendChildNode(scrollBox, content)
  const footer = createNode('ink-box')
  applySceneStyle(footer, { height: 1, flexShrink: 0, flexDirection: 'column' })
  appendChildNode(footer, textLine('FOOTER'))
  appendChildNode(root, header)
  appendChildNode(root, scrollBox)
  appendChildNode(root, footer)
  return { root, scrollBox, content, items }
}

const scrollOf = (box: DOMElement): { top: number; pending: number | undefined } => ({
  top: box.scroll?.scrollTop ?? 0,
  pending: box.scroll?.pendingScrollDelta,
})

function wheel(session: Session, box: DOMElement, rows: number): { top: number; pending: number | undefined } {
  ;(box.scroll ??= {}).pendingScrollDelta = (box.scroll.pendingScrollDelta ?? 0) + rows
  markDirty(box)
  session.step()
  return scrollOf(box)
}

function drainUntilSettled(session: Session, box: DOMElement, limit = 40): Array<{ top: number; pending: number | undefined }> {
  const trail: Array<{ top: number; pending: number | undefined }> = []
  while (box.scroll?.pendingScrollDelta !== undefined && trail.length < limit) {
    markDirty(box)
    session.step()
    trail.push(scrollOf(box))
  }
  return trail
}

const savedTermProgram = process.env.TERM_PROGRAM

console.log('§1 the xterm.js drain: small backlogs apply at once, larger ones step by 2 or 3, the excess beyond 30 rows snaps, the cap is one row short of the viewport')
{
  process.env.TERM_PROGRAM = 'vscode'
  const scene = scrollScene(80)
  const session = new Session(scene.root)
  session.step()
  session.step()
  const box = scene.scrollBox
  const a = wheel(session, box, 4)
  check('a backlog of 4 applies whole in one frame and leaves nothing pending', a.top === 4 && a.pending === undefined, JSON.stringify(a))
  const b = wheel(session, box, 8)
  check('a backlog of 8 steps by 2 and leaves 6 pending', b.top === 6 && b.pending === 6, JSON.stringify(b))
  const bTrail = drainUntilSettled(session, box)
  check('the 6 then steps by 2 and the final 4 applies whole', JSON.stringify(bTrail.map(t => [t.top, t.pending])) === JSON.stringify([[8, 4], [12, undefined]]), JSON.stringify(bTrail))
  const c = wheel(session, box, 20)
  check('a backlog of 20 steps by 3 and leaves 17 pending', c.top === 15 && c.pending === 17, JSON.stringify(c))
  const cTrail = drainUntilSettled(session, box)
  check('the 17 steps 3, 3 (while 12 or more remain), then 2, 2, 2 (under 12), and the last 5 applies whole (top 32)', JSON.stringify(cTrail.map(t => t.top)) === JSON.stringify([18, 21, 23, 25, 27, 32]) && cTrail.at(-1)?.pending === undefined, JSON.stringify(cTrail))
  const d = wheel(session, box, -8)
  check('a negative backlog steps the same way upward: -8 applies -2 and leaves -6', d.top === 30 && d.pending === -6, JSON.stringify(d))
  drainUntilSettled(session, box)
  const e = wheel(session, box, 50)
  check('a backlog of 50 snaps 20 at once plus a step of 3, capped one row short of the 10-row viewport: 9 applied, 41 left', e.top === 24 + 9 && e.pending === 41, JSON.stringify(e))
  const eTrail = drainUntilSettled(session, box)
  check('the remainder of 41 drains 9 (snap 11 + 3, capped), 5 (snap 2 + 3), then 3s while 12 or more remain, 2s under 12 and the last 5 whole, stopping at the content\'s maximum scroll of 70', JSON.stringify(eTrail.map(t => t.top)) === JSON.stringify([42, 47, 50, 53, 56, 59, 62, 65, 67, 69, 70]) && eTrail.at(-1)?.pending === undefined, JSON.stringify(eTrail.map(t => [t.top, t.pending])))
}

console.log('§2 the native drain: three quarters of the remainder per frame, never under 4 rows nor over the cap, the tail whole')
{
  delete process.env.TERM_PROGRAM
  const scene = scrollScene(80)
  const session = new Session(scene.root)
  session.step()
  session.step()
  const box = scene.scrollBox
  const a = wheel(session, box, 8)
  check('a backlog of 8 applies 6 (three quarters) and leaves 2', a.top === 6 && a.pending === 2, JSON.stringify(a))
  const aTrail = drainUntilSettled(session, box)
  check('a remainder under the 4-row floor applies whole', JSON.stringify(aTrail.map(t => [t.top, t.pending])) === JSON.stringify([[8, undefined]]), JSON.stringify(aTrail))
  const b = wheel(session, box, 40)
  check('a backlog of 40 applies the cap (9) and leaves 31', b.top === 17 && b.pending === 31, JSON.stringify(b))
}
if (savedTermProgram === undefined) delete process.env.TERM_PROGRAM
else process.env.TERM_PROGRAM = savedTermProgram

console.log('§3 an overlay that escapes its clean parent is restored after a dirty earlier sibling repaints under it')
{
  const root = rootOf([
    { kind: 'box', style: { height: 4, flexDirection: 'column' }, children: [{ kind: 'text', text: 'row one of the first box' }, { kind: 'text', text: 'row two of the first box' }, { kind: 'text', text: 'row three of the first box' }, { kind: 'text', text: 'row four of the first box' }] },
    { kind: 'box', style: { height: 2, flexDirection: 'column' }, children: [
      { kind: 'text', text: 'the second box' },
      { kind: 'box', style: { position: 'absolute', top: -2, left: 2, width: 9, height: 3, flexDirection: 'column' }, children: [{ kind: 'text', text: 'OVERLAY A' }, { kind: 'text', text: 'OVERLAY B' }, { kind: 'text', text: 'OVERLAY C' }] },
    ] },
  ])
  const first = root.childNodes[0] as DOMElement
  const session = new Session(root)
  const painted = session.step()
  const before = screenLines(painted.frame.screen)
  check('the overlay paints two rows above its parent, over the first box', before[2]?.includes('OVERLAY A') === true && before[3]?.includes('OVERLAY B') === true && before[4]?.includes('OVERLAY C') === true, JSON.stringify(before.slice(0, 6)))
  session.step()
  for (const line of first.childNodes) {
    const text = (line as DOMElement).childNodes[0] as unknown as TextNode
    setTextNodeValue(text, (text as { nodeValue: string }).nodeValue.replace('of the first box', 'REPAINTED FRESH'))
    markDirty(line as DOMElement)
  }
  markDirty(first)
  const repainted = session.step()
  const after = screenLines(repainted.frame.screen)
  check('the first box repainted its rows outside the overlay', after[0]?.includes('REPAINTED FRESH') === true && after[1]?.includes('REPAINTED FRESH') === true, JSON.stringify(after.slice(0, 6)))
  check('the overlay still covers rows 2 and 3 after the repaint under it', after[2]?.includes('OVERLAY A') === true && after[3]?.includes('OVERLAY B') === true, JSON.stringify(after.slice(0, 6)))
  check('the clean parent reported the overlay rect among the frame\'s absolute rects', repainted.signals.absoluteRectsCur.some(rect => Math.floor(rect.y) === 2 && Math.floor(rect.height) === 3), JSON.stringify(repainted.signals.absoluteRectsCur))
}

console.log('§4 scrolled children: the visible band composes, the culled subtrees lose their cache, a taller dirty child shifts the siblings below it and refreshes their cached tops')
{
  const scene = scrollScene(40)
  const session = new Session(scene.root)
  session.step()
  session.step()
  const lines = screenLines(session.step().frame.screen)
  check('rows 1..10 show items 00..09', lines[1] === 'item 00' && lines[10] === 'item 09', JSON.stringify(lines))
  check('a visible child keeps a cached rect; a culled child has none', nodeCache.get(scene.items[3]!) !== undefined && nodeCache.get(scene.items[25]!) === undefined)
  ;(scene.scrollBox.scroll ??= {}).scrollTop = 20
  scene.scrollBox.scroll.pendingScrollDelta = undefined
  markDirty(scene.scrollBox)
  const scrolled = screenLines(session.step().frame.screen)
  check('after a scroll to 20 the band shows items 20..29', scrolled[1] === 'item 20' && scrolled[10] === 'item 29', JSON.stringify(scrolled))
  check('the children that left the band lost their cache; the ones that entered have one', nodeCache.get(scene.items[3]!) === undefined && nodeCache.get(scene.items[25]!) !== undefined)
  const grown = scene.items[21]!
  const text = grown.childNodes[0] as unknown as TextNode
  setTextNodeValue(text, 'item 21\nitem 21 continued')
  markDirty(grown)
  const shifted = screenLines(session.step().frame.screen)
  check('a child that grew by a row pushes the siblings below it down by one', shifted[2] === 'item 21' && shifted[3] === 'item 21 continued' && shifted[4] === 'item 22' && shifted[10] === 'item 28', JSON.stringify(shifted))
  check('the shifted siblings carry refreshed cached tops (item 25 one row lower than item 24, both below the grown child)', (nodeCache.get(scene.items[25]!)?.top ?? -1) === (nodeCache.get(scene.items[24]!)?.top ?? -2) + 1 && (nodeCache.get(scene.items[22]!)?.top ?? -1) === (nodeCache.get(grown)?.top ?? -3) + 2, JSON.stringify([nodeCache.get(grown), nodeCache.get(scene.items[22]!), nodeCache.get(scene.items[24]!), nodeCache.get(scene.items[25]!)]))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(` ✅ COMPOSE WALK ROWS GREEN (${checks} checks)`)
  process.exit(0)
}
console.log(` ❌ COMPOSE WALK ROWS RED (${failures} of ${checks} checks failed)`)
process.exit(1)
