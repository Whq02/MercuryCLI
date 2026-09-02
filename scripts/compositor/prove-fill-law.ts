#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-fill-law.ts — MERCURY Fill law: the fill law at
//  the compose seam.
//
//  The contract (the compositor canvas model): a repaired,
//  vacated or opaque-claimed rectangle resolves to the EFFECTIVE ground — the
//  nearest deliberately-filled ancestor's background — never silently to the
//  terminal ground. Previously four writers punched terminal-ground holes
//  into filled surfaces: the opaque/removed interior fill wrote PLAIN spaces
//  under a bg ancestor, a dirty child's stale-rect clear zeroed the parent's
//  fill, a removed child's vacated rect did the same, and a bg'd scroll
//  surface never resolved its viewport gaps at all.
//
//  All legs drive the PRODUCTION pipeline (the frameHarness: real DOM +
//  layout + renderer) and assert per-cell interned styles — a cell "carries
//  ground G" iff its style's background code equals the code a reference
//  own-bg fill produces (depth-agnostic: truecolor and 256 collapse alike).
// ============================================================================
// Colour depth is an IMPORT-TIME fact (chalk reads the env when colorize
// loads, and a piped proof process resolves level 0 — every bg style would
// vanish before interning). Force truecolor BEFORE the renderer stack loads.
process.env.FORCE_COLOR = '3'
delete process.env.NO_COLOR

const { appendChildNode, createNode, createTextNode, removeChildNode } = await import(
  '../../src/ink/dom.js'
)
type DOMElement = import('../../src/ink/dom.js').DOMElement
const { emptyFrame } = await import('../../src/ink/frame.js')
type Frame = import('../../src/ink/frame.js').Frame
const { default: createRenderer } = await import('../../src/ink/renderer.js')
const { cellAt } = await import('../../src/ink/cell-grid.js')
const { applySceneStyle, makeContext } = await import('../ink-runtime/frameHarness.ts')
type ComposeContext = import('../ink-runtime/frameHarness.ts').ComposeContext

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const OUTER = '#8b1e1e'
const INNER = '#1e3a8b'

type Rig = {
  ctx: ComposeContext
  root: DOMElement
  render: ReturnType<typeof createRenderer>
  cols: number
  rows: number
  compose: (prev?: Frame) => Frame
}

function makeRig(cols: number, rows: number): Rig {
  const ctx = makeContext()
  const root = createNode('ink-root')
  applySceneStyle(root, { width: cols, height: rows, flexDirection: 'column' })
  const render = createRenderer(root, ctx.stylePool)
  const compose = (prev?: Frame): Frame => {
    root.layoutNode!.calculateLayout(cols, rows)
    const front = prev ?? emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
    const back = emptyFrame(rows, cols, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
    return render({
      frontFrame: front,
      backFrame: back,
      isTTY: true,
      terminalWidth: cols,
      terminalRows: rows,
      altScreen: true,
      prevFrameContaminated: prev === undefined,
    }).frame
  }
  return { ctx, root, render, cols, rows, compose }
}

function box(style: Record<string, unknown>, children: DOMElement[] = []): DOMElement {
  const el = createNode('ink-box')
  applySceneStyle(el, { flexDirection: 'row', flexGrow: 0, flexShrink: 1, ...style })
  for (const c of children) appendChildNode(el, c)
  return el
}

function text(s: string): DOMElement {
  const el = createNode('ink-text')
  appendChildNode(el, createTextNode(s) as never)
  return el
}

/** The cell's background SGR code (any depth), or null. */
function bgCodeAt(rig: Rig, frame: Frame, x: number, y: number): string | null {
  const cell = cellAt(frame.screen, x, y)
  if (!cell) return null
  for (const code of rig.ctx.stylePool.get(cell.styleId)) {
    if (code.code.startsWith('\x1b[48;') || /^\x1b\[4[0-7]m$/.test(code.code) || /^\x1b\[10[0-7]m$/.test(code.code)) {
      return code.code
    }
  }
  return null
}

/** The reference bg code for a hex ground — read from a plain own-bg fill. */
function referenceBgCode(hex: string): string {
  const rig = makeRig(10, 3)
  appendChildNode(rig.root, box({ width: 10, height: 3, backgroundColor: hex }))
  const f = rig.compose()
  const code = bgCodeAt(rig, f, 4, 1)
  if (!code) throw new Error(`reference fill for ${hex} produced no bg cell`)
  return code
}

const OUTER_CODE = referenceBgCode(OUTER)
const INNER_CODE = referenceBgCode(INNER)

console.log('the fill law (production compose pipeline)')

// F1 — a dirty child's vacated rows inside an own-bg parent repair to the
// parent's ground, within the SAME composed frame.
{
  const rig = makeRig(24, 8)
  const tall = text('AAAA\nBBBB\nCCCC\nDDDD')
  const parent = box({ width: 24, height: 8, backgroundColor: OUTER, flexDirection: 'column' }, [tall])
  appendChildNode(rig.root, parent)
  const f1 = rig.compose()
  check('F1 setup: frame 1 paints the child glyphs', cellAt(f1.screen, 0, 3)?.char === 'D')

  // Shrink the child: 4 rows → 1 row; mark it dirty like the reconciler would.
  removeChildNode(tall, tall.childNodes[0] as never)
  appendChildNode(tall, createTextNode('AAAA') as never)
  tall.dirty = true
  const f2 = rig.compose(f1)
  const vacated = bgCodeAt(rig, f2, 1, 2)
  check(
    'F1 vacated child rows carry the parent ground (no terminal-ground hole)',
    vacated === OUTER_CODE,
    `row 2 bg = ${JSON.stringify(vacated)}`,
  )
  check('F1 the shrunk child still paints', cellAt(f2.screen, 0, 0)?.char === 'A')
}

// F2 — a REMOVED own-bg fill under a bg ancestor repairs to the ancestor's
// ground (the un-highlight law inside a filled panel).
{
  const rig = makeRig(24, 6)
  const inner = box({ width: 12, height: 2, backgroundColor: INNER })
  const outer = box({ width: 24, height: 6, backgroundColor: OUTER, flexDirection: 'column' }, [inner])
  appendChildNode(rig.root, outer)
  const f1 = rig.compose()
  check('F2 setup: the inner fill paints its own ground', bgCodeAt(rig, f1, 4, 0) === INNER_CODE)

  applySceneStyle(inner, { width: 12, height: 2, backgroundColor: undefined })
  inner.dirty = true
  const f2 = rig.compose(f1)
  const repaired = bgCodeAt(rig, f2, 4, 0)
  check(
    'F2 the removed fill repairs to the ANCESTOR ground, not terminal ground',
    repaired === OUTER_CODE,
    `bg = ${JSON.stringify(repaired)}`,
  )
}

// F3 — an opaque claim under a bg ancestor resolves every interior cell to
// the ancestor's ground ("opaque means every cell resolves").
{
  const rig = makeRig(24, 6)
  const claim = box({ width: 12, height: 3, opaque: true })
  const outer = box({ width: 24, height: 6, backgroundColor: OUTER, flexDirection: 'column' }, [claim])
  appendChildNode(rig.root, outer)
  const f1 = rig.compose()
  const inside = bgCodeAt(rig, f1, 5, 1)
  check(
    'F3 opaque-under-bg resolves to the ancestor ground',
    inside === OUTER_CODE,
    `bg = ${JSON.stringify(inside)}`,
  )
}

// F3b — an opaque claim with NO bg ancestor stays byte-identical zero cells
// (the erase-at-claim epoch guarantee owns the physical blank).
{
  const rig = makeRig(24, 6)
  const claim = box({ width: 12, height: 3, opaque: true })
  appendChildNode(rig.root, box({ width: 24, height: 6, flexDirection: 'column' }, [claim]))
  const f1 = rig.compose()
  const cell = cellAt(f1.screen, 5, 1)
  check(
    'F3b opaque with no ancestor ground stays a zero cell (zero-diff bytes)',
    cell !== undefined && cell.styleId === rig.ctx.stylePool.none && cell.char === ' ',
    JSON.stringify(cell),
  )
}

// F4 — a bg'd scroll surface resolves its viewport gaps to its own ground on
// first paint.
{
  const rig = makeRig(24, 8)
  const content = box({ flexDirection: 'column', flexShrink: 0 }, [text('top line')])
  const scroller = box(
    { width: 24, height: 8, overflowY: 'scroll', backgroundColor: OUTER, flexDirection: 'column' },
    [content],
  )
  appendChildNode(rig.root, scroller)
  const f1 = rig.compose()
  const gap = bgCodeAt(rig, f1, 3, 5)
  check(
    'F4 bg’d scroll surface fills its viewport gaps with its own ground',
    gap === OUTER_CODE,
    `gap bg = ${JSON.stringify(gap)}`,
  )
  check('F4 the child still paints over the fill', cellAt(f1.screen, 0, 0)?.char === 't')
}

// F6 — SIBLING SHIFT-DOWN under a bg parent (the verify-wave refutation,
// reverted + pinned): A grows 1→2 rows (dirty), B below shifts down
// (positionChanged, not dirty). B's vacated-rect handling must NOT wipe
// A's freshly-composed second row — buffer.clear is damage-only and the
// parent's per-frame interior fill already owns the ground; a real write
// there applies in op order over the earlier sibling's same-frame content
// and persists through clean-frame self-blits.
{
  const rig = makeRig(24, 8)
  const a = text('AAAA')
  const b = text('BBBB')
  const parent = box({ width: 24, height: 8, backgroundColor: OUTER, flexDirection: 'column' }, [a, b])
  appendChildNode(rig.root, parent)
  const f1 = rig.compose()
  check('F6 setup: frame 1 stacks A then B', cellAt(f1.screen, 0, 0)?.char === 'A' && cellAt(f1.screen, 0, 1)?.char === 'B')

  removeChildNode(a, a.childNodes[0] as never)
  appendChildNode(a, createTextNode('AAAA\nZZZZ') as never)
  a.dirty = true
  const f2 = rig.compose(f1)
  check('F6 the earlier sibling’s NEW row survives the later sibling’s vacated rect', cellAt(f2.screen, 0, 1)?.char === 'Z')
  check('F6 the shifted sibling paints at its new position', cellAt(f2.screen, 0, 2)?.char === 'B')
  const f3 = rig.compose(f2)
  check('F6 a clean frame self-blits the CORRECT model (no persisting hole)', cellAt(f3.screen, 0, 1)?.char === 'Z')
  check('F6 the parent ground still covers its interior gaps', bgCodeAt(rig, f2, 4, 5) === OUTER_CODE)
}

// F5 — a plain unfilled tree composes zero new bg cells (the law never
// invents fills where no ancestor claimed a ground).
{
  const rig = makeRig(24, 6)
  appendChildNode(rig.root, box({ width: 24, height: 6, flexDirection: 'column' }, [text('hello')]))
  const f1 = rig.compose()
  let bgCells = 0
  for (let y = 0; y < 6; y++) for (let x = 0; x < 24; x++) if (bgCodeAt(rig, f1, x, y)) bgCells++
  check('F5 no ancestor ground ⇒ zero bg cells anywhere (zero-diff bytes)', bgCells === 0, `${bgCells} bg cells`)
}

if (failures > 0) {
  console.error(`\n❌ ${failures} FILL-LAW PROOF(S) FAILED`)
  process.exit(1)
}
console.log('\n✅ ALL FILL-LAW PROOFS PASS')
