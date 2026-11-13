#!/usr/bin/env bun
// gate-watch: src/ink/compose-walk.ts src/ink/cell-grid.ts src/ink/renderer.ts
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendChildNode, createNode, setAttribute, setTextNodeValue } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
type TextNode = import('../../src/ink/dom.js').TextNode
const { cellAt } = await import('../../src/ink/cell-grid.js')
type Screen = import('../../src/ink/cell-grid.js').Screen
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { applySceneStyle, buildDom, makeContext } = await import('./frameHarness.js')
type ComposeContext = import('./frameHarness.js').ComposeContext

const COLS = 32
const ROWS = 6
const BG_A = '#0d181b'
const BG_B = '#201810'

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

type World = {
  ctx: ComposeContext
  root: DOMElement
  scroll: DOMElement
  items: DOMElement[]
  render: ReturnType<typeof createRenderer>
  front: Frame
  back: Frame
}

function buildWorld(ctx: ComposeContext, texts: string[], bg: string | undefined): World {
  const root = createNode('ink-root')
  applySceneStyle(root, { flexDirection: 'column', width: COLS, height: ROWS })
  const items = texts.map(t => buildDom({ kind: 'text', text: t }))
  const content = buildDom({ kind: 'box', style: { flexDirection: 'column', width: COLS, flexShrink: 0 } })
  for (const item of items) appendChildNode(content, item)
  const scroll = buildDom({
    kind: 'box',
    style: {
      flexDirection: 'column',
      width: COLS,
      height: ROWS,
      paddingTop: 1,
      overflowX: 'scroll',
      overflowY: 'scroll',
      ...(bg ? { backgroundColor: bg as never } : {}),
    },
  })
  setAttribute(scroll, 'stickyScroll', true)
  appendChildNode(scroll, content)
  appendChildNode(root, scroll)
  return {
    ctx,
    root,
    scroll,
    items,
    render: createRenderer(root, ctx.stylePool),
    front: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
    back: emptyFrame(ROWS, COLS, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool),
  }
}

function step(w: World, contaminated: boolean): Screen {
  w.root.layoutNode!.calculateLayout(COLS, ROWS)
  const { frame } = w.render({
    frontFrame: w.front,
    backFrame: w.back,
    isTTY: true,
    terminalWidth: COLS,
    terminalRows: ROWS,
    altScreen: true,
    prevFrameContaminated: contaminated,
  })
  w.back = w.front
  w.front = frame
  return frame.screen
}

function screenMismatch(a: Screen, b: Screen): string | null {
  let count = 0
  let first = ''
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const ca = cellAt(a, x, y)!
      const cb = cellAt(b, x, y)!
      if (ca.char !== cb.char || ca.styleId !== cb.styleId) {
        count++
        if (!first) first = `(${x},${y}) char=${JSON.stringify(ca.char)}/${JSON.stringify(cb.char)} style=${ca.styleId}/${cb.styleId}`
      }
    }
  }
  return count === 0 ? null : `${count} cells differ, first at ${first}`
}

console.log('§1 A scroll box with its own backgroundColor keeps its ground on every cell when repainted without scrolling')
{
  const ctx = makeContext()
  const live = buildWorld(ctx, ['row zero', 'row one', 'row two'], BG_A)
  step(live, false)

  setTextNodeValue(live.items[1]!.childNodes[0] as TextNode, 'row one updated')
  const repainted = step(live, false)

  const freshMount = buildWorld(ctx, ['row zero', 'row one updated', 'row two'], BG_A)
  const expected = step(freshMount, true)

  const diff = screenMismatch(repainted, expected)
  check(
    'repaint without scroll matches a fresh mount on paddingTop, short-line tails, and empty rows below content',
    diff === null,
    diff ?? '',
  )
  check(
    'every cell in the scroll viewport carries a non-empty background styleId',
    cellAt(repainted, 0, 0)!.styleId !== ctx.stylePool.none &&
      cellAt(repainted, COLS - 1, 2)!.styleId !== ctx.stylePool.none &&
      cellAt(repainted, 4, ROWS - 1)!.styleId !== ctx.stylePool.none,
  )
}

console.log('\n§2 A contaminated whole-frame repaint (prevFrameContaminated=true after mount) also preserves the scroll box ground')
{
  const ctx = makeContext()
  const live = buildWorld(ctx, ['alpha', 'beta'], BG_A)
  step(live, false)
  const afterContaminated = step(live, true)

  const freshMount = buildWorld(ctx, ['alpha', 'beta'], BG_A)
  const expected = step(freshMount, true)

  const diff = screenMismatch(afterContaminated, expected)
  check(
    'contaminated repaint with contentWas populated keeps the scroll box ground across the whole viewport',
    diff === null,
    diff ?? '',
  )
}

console.log('\n§3 Changing or removing a scroll box own backgroundColor refreshes clean children instead of blitting old ground')
{
  const ctx = makeContext()
  const live = buildWorld(ctx, ['first line', 'second line'], BG_A)
  step(live, false)

  applySceneStyle(live.scroll, {
    flexDirection: 'column',
    width: COLS,
    height: ROWS,
    paddingTop: 1,
    overflowX: 'scroll',
    overflowY: 'scroll',
    backgroundColor: BG_B as never,
  })
  const recoloured = step(live, false)
  const freshB = step(buildWorld(ctx, ['first line', 'second line'], BG_B), true)
  const diffB = screenMismatch(recoloured, freshB)
  check('switching own backgroundColor updates clean children and empty rows to the new ground', diffB === null, diffB ?? '')

  applySceneStyle(live.scroll, {
    flexDirection: 'column',
    width: COLS,
    height: ROWS,
    paddingTop: 1,
    overflowX: 'scroll',
    overflowY: 'scroll',
  })
  const cleared = step(live, false)
  const freshNone = step(buildWorld(ctx, ['first line', 'second line'], undefined), true)
  const diffNone = screenMismatch(cleared, freshNone)
  check('removing own backgroundColor clears old ground from clean children and empty rows', diffNone === null, diffNone ?? '')
}

console.log(`\nprove-scroll-box-own-ground: ${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
