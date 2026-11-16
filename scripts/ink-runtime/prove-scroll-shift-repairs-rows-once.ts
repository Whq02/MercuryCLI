#!/usr/bin/env bun
// gate-watch: src/ink/compose-walk.ts src/ink/renderer.ts src/ink/compose-buffer.ts
export {}
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { appendChildNode, createNode, createTextNode, markDirty, setAttribute } = await import('../../src/ink/dom.js')
type DOMElement = import('../../src/ink/dom.js').DOMElement
const { cellAt } = await import('../../src/ink/cell-grid.js')
type Screen = import('../../src/ink/cell-grid.js').Screen
const { lastComposeCounts } = await import('../../src/ink/compose-buffer.js')
const { emptyFrame } = await import('../../src/ink/frame.js')
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
  if (live.width !== fresh.width || live.height !== fresh.height) return `size ${live.width}x${live.height} vs ${fresh.width}x${fresh.height}`
  let cells = 0
  let first = -1
  for (let at = 0; at < live.width * live.height * 2; at += 2) {
    if (live.cells[at] === fresh.cells[at] && live.cells[at + 1] === fresh.cells[at + 1]) continue
    cells++
    if (first < 0) first = at >> 1
  }
  if (first < 0) return null
  const y = Math.floor(first / live.width)
  return `${cells} cells differ, first in row ${y}: shifted ${JSON.stringify(rowOf(live, y))} · fresh ${JSON.stringify(rowOf(fresh, y))}`
}

const box = (style: Styles, children: DOMElement[] = []): DOMElement => {
  const el = buildDom({ kind: 'box', style })
  for (const child of children) appendChildNode(el, child)
  return el
}

const words = (text: string): DOMElement => {
  const el = createNode('ink-text')
  applySceneStyle(el, { flexGrow: 0, flexShrink: 1, flexDirection: 'row', textWrap: 'wrap' })
  appendChildNode(el, createTextNode(text) as never)
  return el
}

type Shape = 'reaching' | 'tidy'

function makeWorld(ctx: ComposeContext, cols: number, rows: number, count: number, shape: Shape, regionScroll: boolean, pillRows: number) {
  const root = createNode('ink-root')
  applySceneStyle(root, { flexDirection: 'column', width: cols, height: rows })
  const list = box({ flexDirection: 'column', width: cols, flexShrink: 0 })
  for (let i = 0; i < count; i++) {
    const label = `row ${String(i).padStart(2, '0')}`
    const line =
      shape === 'reaching'
        ? box({ flexDirection: 'column', width: cols }, [
            box({ flexDirection: 'column', width: cols }, [box({ flexDirection: 'row', width: cols, height: 1 }, [words(`${label} ${'holds words that run past the width of its one row '.repeat(2)}`)])]),
          ])
        : box({ flexDirection: 'row', width: cols, height: 1 }, [words(label)])
    appendChildNode(list, box({ flexDirection: 'column', width: cols, flexShrink: 0 }, [line, box({ width: cols, height: 2 })]))
  }
  const content = box({ flexDirection: 'column', width: cols, flexShrink: 0 }, [list])
  const scroller = box({ flexDirection: 'column', width: cols, height: rows, overflowX: 'scroll', overflowY: 'scroll' }, [content])
  setAttribute(scroller, 'stickyScroll', true)
  appendChildNode(root, scroller)
  if (pillRows > 0) {
    appendChildNode(root, box({ position: 'absolute', bottom: 0, left: 0, width: cols, height: pillRows }, [words('[ back to the bottom ]')]))
  }
  const render = createRenderer(root, ctx.stylePool)
  let front = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  let back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  return {
    scroller,
    paint(scratch: boolean) {
      root.layoutNode!.calculateLayout(cols, rows)
      const res = render({ frontFrame: front, backFrame: back, isTTY: true, terminalWidth: cols, terminalRows: rows, altScreen: true, prevFrameContaminated: scratch, regionScrollUsable: regionScroll })
      back = front
      front = res.frame
      return res
    },
  }
}

type Reading = { handed: number[]; ops: number[]; shifted: number[]; drift: string | null; stopped: boolean }

function wheelUp(shape: Shape, regionScroll: boolean, pillRows: number, steps: number): Reading {
  const cols = 40
  const rows = 12
  const ctx = makeContext()
  const live = makeWorld(ctx, cols, rows, 30, shape, regionScroll, pillRows)
  const fresh = makeWorld(ctx, cols, rows, 30, shape, regionScroll, pillRows)
  live.paint(false)
  fresh.paint(true)
  const reading: Reading = { handed: [], ops: [], shifted: [], drift: null, stopped: false }
  for (let step = 0; step < steps; step++) {
    for (const world of [live, fresh]) {
      const scroll = (world.scroller.scroll ??= {})
      scroll.stickyScroll = false
      scroll.pendingScrollDelta = -1
      markDirty(world.scroller)
    }
    const shown = live.paint(false)
    const ops = lastComposeCounts.ops
    const blit = lastComposeCounts.blit
    const whole = fresh.paint(true)
    reading.handed.push(shown.signals.absoluteRectsCur.length + shown.signals.reachRectsCur.length)
    reading.ops.push(ops)
    reading.shifted.push(blit)
    if (reading.drift === null) {
      const diff = difference(shown.frame.screen, whole.frame.screen)
      if (diff !== null) reading.drift = `step ${step + 1}: ${diff}`
    }
    if (reading.handed[step]! > 40 * Math.max(1, reading.handed[0]!)) {
      reading.stopped = true
      break
    }
  }
  return reading
}

const STEPS = 9
const say = (values: number[]): string => values.join(', ')

console.log('§1 Rows whose text runs past its own box: nine one-row wheel steps hand the next frame a list that does not grow')
for (const regionScroll of [true, false]) {
  const road = regionScroll ? 'region scroll' : 'rect shift'
  const r = wheelUp('reaching', regionScroll, 0, STEPS)
  check(`${road}: the scene is the one in question: every step moved rows by reuse of the frame before, and its rows reach past their boxes`, r.shifted.length > 0 && r.shifted.every(cells => cells > 0) && r.handed[0]! > 0, `reused cells per step ${say(r.shifted)}; rects handed on ${say(r.handed)}`)
  check(`${road}: the rects handed to the next frame hold level over ${STEPS} steps`, !r.stopped && r.handed.length === STEPS && Math.max(...r.handed) <= 2 * r.handed[0]!, `rects handed on per step: ${say(r.handed)}${r.stopped ? ' (stopped: forty times the first step)' : ''}`)
  check(`${road}: the painter's work per step holds level`, !r.stopped && Math.max(...r.ops) <= 2 * r.ops[0]!, `operations per step: ${say(r.ops)}`)
  check(`${road}: every step paints what a whole repaint paints`, r.drift === null, r.drift ?? '')
}

console.log('\n§2 The same under an overlay that stands over the pane (the pill): its rows are repaired, once')
for (const regionScroll of [true, false]) {
  const road = regionScroll ? 'region scroll' : 'rect shift'
  const r = wheelUp('reaching', regionScroll, 1, STEPS)
  check(`${road}: the rects handed on hold level`, !r.stopped && r.handed.length === STEPS && Math.max(...r.handed) <= 2 * r.handed[0]!, `rects handed on per step: ${say(r.handed)}${r.stopped ? ' (stopped: forty times the first step)' : ''}`)
  check(`${road}: the painter's work per step holds level`, !r.stopped && Math.max(...r.ops) <= 2 * r.ops[0]!, `operations per step: ${say(r.ops)}`)
  check(`${road}: every step paints what a whole repaint paints`, r.drift === null, r.drift ?? '')
}

console.log('\n§3 Control: rows that keep inside their boxes were level before and are level now')
for (const regionScroll of [true, false]) {
  const road = regionScroll ? 'region scroll' : 'rect shift'
  const r = wheelUp('tidy', regionScroll, 1, STEPS)
  check(`${road}: level, and equal to a whole repaint`, !r.stopped && Math.max(...r.handed) <= 2 * Math.max(1, r.handed[0]!) && Math.max(...r.ops) <= 2 * r.ops[0]! && r.drift === null, `rects ${say(r.handed)}; operations ${say(r.ops)}; ${r.drift ?? 'no drift'}`)
}

console.log(`\n${checks} checks, ${failures} failed`)
if (failures > 0) {
  console.log('prove-scroll-shift-repairs-rows-once: RED')
  process.exit(1)
}
console.log('prove-scroll-shift-repairs-rows-once: ALL PASS')
