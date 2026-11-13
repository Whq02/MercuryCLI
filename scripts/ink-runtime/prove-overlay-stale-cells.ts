#!/usr/bin/env bun
// gate-watch: src/ink/compose-walk.ts src/ink/renderer.ts src/ink/compose-buffer.ts src/ink/cell-grid.ts
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendChildNode, createNode, removeChildNode, setTextNodeValue } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
type TextNode = import('../../src/ink/dom.js').TextNode
const { cellAt } = await import('../../src/ink/cell-grid.js')
type Screen = import('../../src/ink/cell-grid.js').Screen
const { lastComposeCounts } = await import('../../src/ink/compose-buffer.js')
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { applySceneStyle, buildDom, makeContext } = await import('./frameHarness.js')
type ComposeContext = import('./frameHarness.js').ComposeContext

const COLS = 50
const ROWS = 14

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

function rowText(screen: Screen, y: number): string {
  return Array.from({ length: screen.width }, (_, x) => cellAt(screen, x, y)?.char ?? ' ').join('').trimEnd()
}

function screenMismatch(live: Screen, fresh: Screen): string | null {
  let cells = 0
  let first = ''
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const a = cellAt(live, x, y)!
      const b = cellAt(fresh, x, y)!
      if (a.char !== b.char || a.styleId !== b.styleId) {
        cells++
        if (!first) first = `row ${y}: reused=${JSON.stringify(rowText(live, y))} fresh=${JSON.stringify(rowText(fresh, y))}`
      }
    }
  }
  return cells === 0 ? null : `${cells} cells differ, first at ${first}`
}

console.log('§1 A see-through absolute container whose inner opaque card shrinks (FloatingPopup shape) leaves no old cells')
{
  const ctx = makeContext()
  const makeWorld = () => {
    const root = createNode('ink-root')
    applySceneStyle(root, { flexDirection: 'column', width: COLS, height: ROWS })
    const pane = buildDom({
      kind: 'box',
      style: { flexDirection: 'column', width: COLS, height: ROWS, overflow: 'hidden' },
      children: Array.from({ length: ROWS }, (_, i) => ({
        kind: 'text' as const,
        text: `transcript line ${String(i).padStart(2, '0')} behind floating popup`,
      })),
    })
    const cardRows = Array.from({ length: 6 }, (_, i) => buildDom({ kind: 'text', text: `setting option ${i}` }))
    const card = buildDom({
      kind: 'box',
      style: { flexDirection: 'column', width: 30, borderStyle: 'round', opaque: true },
    })
    for (const r of cardRows) appendChildNode(card, r)
    const floating = buildDom({
      kind: 'box',
      style: {
        position: 'absolute',
        left: 10,
        top: 0,
        width: 30,
        height: ROWS,
        flexDirection: 'column',
        justifyContent: 'center',
      },
    })
    appendChildNode(floating, card)
    appendChildNode(root, pane)
    appendChildNode(root, floating)
    return {
      root,
      card,
      cardRows,
      render: createRenderer(root, ctx.stylePool),
      front: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      back: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    }
  }
  const paint = (w: ReturnType<typeof makeWorld>, scratch: boolean): Screen => {
    w.root.layoutNode!.calculateLayout(COLS, ROWS)
    const { frame } = w.render({
      frontFrame: w.front,
      backFrame: w.back,
      isTTY: true,
      terminalWidth: COLS,
      terminalRows: ROWS,
      altScreen: true,
      prevFrameContaminated: scratch,
    })
    w.back = w.front
    w.front = frame
    return frame.screen
  }
  const live = makeWorld()
  const fresh = makeWorld()
  paint(live, false)
  paint(fresh, true)
  for (let i = 5; i >= 2; i--) {
    removeChildNode(live.card, live.cardRows[i]!)
    removeChildNode(fresh.card, fresh.cardRows[i]!)
  }
  const diff = screenMismatch(paint(live, false), paint(fresh, true))
  check('shrinking centered card inside a see-through absolute box restores covered transcript rows', diff === null, diff ?? '')
}

console.log('\n§2 Direct absolute overlays that shrink, move, hide via display:none, or shrink see-through text')
{
  const ctx = makeContext()
  const makeWorld = () => {
    const root = createNode('ink-root')
    applySceneStyle(root, { flexDirection: 'column', width: COLS, height: ROWS })
    const pane = buildDom({
      kind: 'box',
      style: { flexDirection: 'column', width: COLS, height: ROWS, overflow: 'hidden' },
      children: Array.from({ length: ROWS }, (_, i) => ({
        kind: 'text' as const,
        text: `background row ${String(i).padStart(2, '0')} across fifty columns`,
      })),
    })
    const popupText = buildDom({ kind: 'text', text: 'line A\nline B\nline C\nline D' })
    const popup = buildDom({
      kind: 'box',
      style: {
        position: 'absolute',
        left: 8,
        top: 2,
        width: 24,
        borderStyle: 'round',
        opaque: true,
        overflow: 'hidden',
        flexDirection: 'column',
      },
    })
    appendChildNode(popup, popupText)
    appendChildNode(root, pane)
    appendChildNode(root, popup)
    return {
      root,
      popup,
      popupText,
      render: createRenderer(root, ctx.stylePool),
      front: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      back: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    }
  }
  const paint = (w: ReturnType<typeof makeWorld>, scratch: boolean): Screen => {
    w.root.layoutNode!.calculateLayout(COLS, ROWS)
    const { frame } = w.render({
      frontFrame: w.front,
      backFrame: w.back,
      isTTY: true,
      terminalWidth: COLS,
      terminalRows: ROWS,
      altScreen: true,
      prevFrameContaminated: scratch,
    })
    w.back = w.front
    w.front = frame
    return frame.screen
  }
  const live = makeWorld()
  const fresh = makeWorld()
  paint(live, false)
  paint(fresh, true)

  setTextNodeValue(live.popupText.childNodes[0] as TextNode, 'line A shorter')
  setTextNodeValue(fresh.popupText.childNodes[0] as TextNode, 'line A shorter')
  const diffShrink = screenMismatch(paint(live, false), paint(fresh, true))
  check('shrinking an opaque absolute overlay restores the background rows below its new bottom', diffShrink === null, diffShrink ?? '')

  setTextNodeValue(live.popupText.childNodes[0] as TextNode, 'line A blink')
  setTextNodeValue(fresh.popupText.childNodes[0] as TextNode, 'line A blink')
  const fixedUpdate = paint(live, false)
  const fixedCounts = { ...lastComposeCounts }
  const diffFixed = screenMismatch(fixedUpdate, paint(fresh, true))
  check(
    'updating inside a fixed-rect opaque absolute overlay still blits the clean background sibling',
    diffFixed === null && fixedCounts.blit >= COLS * ROWS,
    JSON.stringify({ diffFixed, fixedCounts }),
  )

  applySceneStyle(live.popup, {
    position: 'absolute',
    left: 16,
    top: 6,
    width: 24,
    borderStyle: 'round',
    opaque: true,
    overflow: 'hidden',
    flexDirection: 'column',
  })
  applySceneStyle(fresh.popup, {
    position: 'absolute',
    left: 16,
    top: 6,
    width: 24,
    borderStyle: 'round',
    opaque: true,
    overflow: 'hidden',
    flexDirection: 'column',
  })
  const diffMove = screenMismatch(paint(live, false), paint(fresh, true))
  check('moving an absolute overlay restores the cells at its old coordinates', diffMove === null, diffMove ?? '')

  applySceneStyle(live.popup, {
    position: 'absolute',
    left: 16,
    top: 6,
    width: 24,
    flexDirection: 'column',
  })
  applySceneStyle(fresh.popup, {
    position: 'absolute',
    left: 16,
    top: 6,
    width: 24,
    flexDirection: 'column',
  })
  const diffSeeThroughTransition = screenMismatch(paint(live, false), paint(fresh, true))
  check('an overlay becoming see-through drops its old border cells cleanly', diffSeeThroughTransition === null, diffSeeThroughTransition ?? '')

  setTextNodeValue(live.popupText.childNodes[0] as TextNode, 'hi')
  setTextNodeValue(fresh.popupText.childNodes[0] as TextNode, 'hi')
  const diffSeeThroughText = screenMismatch(paint(live, false), paint(fresh, true))
  check('shortening text inside a see-through absolute overlay restores uncovered background glyphs', diffSeeThroughText === null, diffSeeThroughText ?? '')

  applySceneStyle(live.popup, {
    position: 'absolute',
    left: 16,
    top: 6,
    width: 24,
    flexDirection: 'column',
    display: 'none',
  })
  applySceneStyle(fresh.popup, {
    position: 'absolute',
    left: 16,
    top: 6,
    width: 24,
    flexDirection: 'column',
    display: 'none',
  })
  const diffHide = screenMismatch(paint(live, false), paint(fresh, true))
  check('hiding an absolute overlay via display:none restores all covered background cells', diffHide === null, diffHide ?? '')
}

console.log('\n§3 Reusing a clean overlay over a repainted wide-CJK background mends split wide pairs at left and right edges')
{
  const ctx = makeContext()
  const makeWideWorld = () => {
    const root = createNode('ink-root')
    applySceneStyle(root, { flexDirection: 'column', width: COLS, height: ROWS })
    const wideLine = buildDom({ kind: 'text', text: 'ab漢字漢字漢字漢字漢字漢字漢字cd' })
    const pane = buildDom({
      kind: 'box',
      style: { flexDirection: 'column', width: COLS, height: ROWS, overflow: 'hidden' },
    })
    appendChildNode(pane, wideLine)
    const popup = buildDom({
      kind: 'box',
      style: {
        position: 'absolute',
        left: 3,
        top: 0,
        width: 10,
        height: 3,
        borderStyle: 'round',
        opaque: true,
        overflow: 'hidden',
      },
      children: [{ kind: 'text', text: 'ok' }],
    })
    appendChildNode(root, pane)
    appendChildNode(root, popup)
    return {
      root,
      wideLine,
      render: createRenderer(root, ctx.stylePool),
      front: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
      back: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    }
  }
  const paint = (w: ReturnType<typeof makeWideWorld>, scratch: boolean): Screen => {
    w.root.layoutNode!.calculateLayout(COLS, ROWS)
    const { frame } = w.render({
      frontFrame: w.front,
      backFrame: w.back,
      isTTY: true,
      terminalWidth: COLS,
      terminalRows: ROWS,
      altScreen: true,
      prevFrameContaminated: scratch,
    })
    w.back = w.front
    w.front = frame
    return frame.screen
  }
  const live = makeWideWorld()
  const fresh = makeWideWorld()
  paint(live, false)
  paint(fresh, true)
  setTextNodeValue(live.wideLine.childNodes[0] as TextNode, 'xy漢字漢字漢字漢字漢字漢字漢字zw')
  setTextNodeValue(fresh.wideLine.childNodes[0] as TextNode, 'xy漢字漢字漢字漢字漢字漢字漢字zw')
  const reused = paint(live, false)
  const expected = paint(fresh, true)
  let wideMismatch = ''
  for (let x = 0; x < COLS; x++) {
    const a = cellAt(reused, x, 0)!
    const b = cellAt(expected, x, 0)!
    if (a.char !== b.char || a.width !== b.width || a.styleId !== b.styleId) {
      wideMismatch = `col ${x}: reused=${JSON.stringify(a)} fresh=${JSON.stringify(b)}`
      break
    }
  }
  check('blitting a clean overlay onto a repainted CJK row mends both split wide edges identically to fresh paint', wideMismatch === '', wideMismatch)
}

console.log(`\nprove-overlay-stale-cells: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
