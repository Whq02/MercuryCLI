#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-hit-map.ts — the hit-map
//  laws.
//
//  Drives the PRODUCTION hit path (renderNodeToOutput populates nodeCache →
//  hitTest resolves pointer coordinates) over composed scenes and pins:
//
//    • CONTAINMENT — every hit node's committed rect contains the point and
//      lies within the painted screen; sweeping EVERY cell never yields a
//      node whose rect excludes the probe;
//    • TOPMOST WINS — over overlapping siblings the later-painted one
//      resolves;
//    • display:none subtrees are unreachable;
//    • COMMITTED GENERATION — after the SAME tree re-lays out (a rail
//      widens), hits at the old coordinates resolve to the NEW occupant;
//      stale rects cannot be hit.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-hit-map.ts
// ============================================================================
import {
  appendChildNode,
  createNode,
  createTextNode,
  type DOMElement,
} from '../../src/ink/dom.js'
import { emptyFrame } from '../../src/ink/frame.js'
import { hitTest } from '../../src/ink/geometry/hit.js'
import { nodeCache } from '../../src/ink/node-cache.js'
import createRenderer from '../../src/ink/renderer.js'
import { applySceneStyle, buildDom, makeContext, type SceneNode } from './frameHarness.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) {
    failures++
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const COLS = 40
const ROWS = 10

function compose(root: DOMElement): void {
  const ctx = makeContext()
  root.layoutNode!.calculateLayout(COLS, ROWS)
  const render = createRenderer(root, ctx.stylePool)
  render({
    frontFrame: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    backFrame: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: true,
  })
}

function mkRoot(spec: SceneNode): DOMElement {
  const root = createNode('ink-root')
  applySceneStyle(root, { width: COLS, height: ROWS, flexDirection: 'column' })
  appendChildNode(root, buildDom(spec))
  return root
}

console.log('bedrock hit map — committed-generation pointer laws')

// -- Containment sweep ---------------------------------------------------------
{
  const root = mkRoot({
    kind: 'box',
    style: { flexDirection: 'row', height: ROWS },
    children: [
      { kind: 'box', style: { width: 12, borderStyle: 'single' }, children: [{ kind: 'text', text: 'rail' }] },
      { kind: 'box', style: { flexGrow: 1, padding: 1 }, children: [{ kind: 'text', text: 'center content' }] },
      { kind: 'box', style: { width: 8 }, children: [{ kind: 'text', text: 'right' }] },
    ],
  })
  compose(root)
  let violations = 0
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const hit = hitTest(root, x, y)
      if (!hit) continue
      const rect = nodeCache.get(hit)
      if (!rect) {
        violations++
        continue
      }
      if (
        x < rect.x ||
        x >= rect.x + rect.width ||
        y < rect.y ||
        y >= rect.y + rect.height ||
        rect.x < 0 ||
        rect.y < 0 ||
        rect.x + rect.width > COLS ||
        rect.y + rect.height > ROWS
      ) {
        violations++
      }
    }
  }
  check('containment sweep: every hit rect contains its probe, inside the screen', violations === 0, `${violations} violations`)
}

// -- Topmost sibling wins -------------------------------------------------------
{
  const root = mkRoot({
    kind: 'box',
    style: { height: ROWS },
    children: [
      {
        kind: 'box',
        style: { position: 'absolute', marginLeft: 2, marginTop: 1, width: 10, height: 4 },
        children: [{ kind: 'text', text: 'under' }],
      },
      {
        kind: 'box',
        style: { position: 'absolute', marginLeft: 6, marginTop: 2, width: 10, height: 4 },
        children: [{ kind: 'text', text: 'over' }],
      },
    ],
  })
  compose(root)
  const hit = hitTest(root, 7, 3) // inside both; the later sibling paints on top
  let text = ''
  const collect = (n: DOMElement): void => {
    for (const c of n.childNodes) {
      if (c.nodeName === '#text') text += (c as { nodeValue?: string }).nodeValue ?? ''
      else collect(c as DOMElement)
    }
  }
  if (hit) collect(hit)
  check('topmost sibling wins the overlap', text.includes('over') && !text.includes('under'), JSON.stringify(text))
}

// -- display:none unreachable ----------------------------------------------------
{
  const root = mkRoot({
    kind: 'box',
    style: { flexDirection: 'row', height: ROWS },
    children: [
      { kind: 'box', style: { width: 20, display: 'none' }, children: [{ kind: 'text', text: 'ghost' }] },
      { kind: 'box', style: { flexGrow: 1 }, children: [{ kind: 'text', text: 'visible' }] },
    ],
  })
  compose(root)
  for (let x = 0; x < COLS; x += 4) {
    const hit = hitTest(root, x, 0)
    if (!hit) continue
    let text = ''
    const collect = (n: DOMElement): void => {
      for (const c of n.childNodes) {
        if (c.nodeName === '#text') text += (c as { nodeValue?: string }).nodeValue ?? ''
        else collect(c as DOMElement)
      }
    }
    collect(hit)
    if (text.includes('ghost')) {
      check('display:none subtree unreachable', false, `hit ghost at x=${x}`)
      break
    }
  }
}

// -- Committed generation: re-layout moves the hit boundary ----------------------
{
  const railStyle = { width: 12, borderStyle: 'single' as const }
  const rail: SceneNode = { kind: 'box', style: railStyle, children: [{ kind: 'text', text: 'rail' }] }
  const center: SceneNode = { kind: 'box', style: { flexGrow: 1 }, children: [{ kind: 'text', text: 'center' }] }
  const root = mkRoot({ kind: 'box', style: { flexDirection: 'row', height: ROWS }, children: [rail, center] })
  compose(root)

  const probe = 16 // inside CENTER at rail width 12
  const before = hitTest(root, probe, 2)
  const beforeRect = before && nodeCache.get(before)
  check('generation A: probe lands in the center pane', !!beforeRect && beforeRect.x >= 12, JSON.stringify(beforeRect))

  // Widen the rail on the SAME tree and re-lay out + re-compose.
  const railEl = (root.childNodes[0] as DOMElement).childNodes[0] as DOMElement
  applySceneStyle(railEl, { ...railStyle, width: 24 })
  compose(root)
  const after = hitTest(root, probe, 2)
  const afterRect = after && nodeCache.get(after)
  check(
    'generation B: the SAME probe now lands in the widened rail',
    !!afterRect && afterRect.x < 12 && afterRect.x + afterRect.width >= 24,
    JSON.stringify(afterRect),
  )
}

if (failures > 0) {
  console.log(`\nbedrock hit map: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock hit map: green')
