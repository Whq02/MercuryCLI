#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-search-highlight-column.ts — the current-match
//  search highlight carries a COLUMN offset beside its row offset
//  (FN-016 R6).
//
//  THE DEFECT: the seek path scans the target message off-screen —
//  scanElementSubtree composes the message subtree at offsetX
//  −getComputedLeft(), so MatchPosition.col is MESSAGE-relative — and
//  applyPositionedHighlight then used position.col as an ABSOLUTE screen
//  column: only the row was translated. In the default cockpit the
//  transcript sits right of a lanes rail plus a border plus a gutter, so
//  the current-match block painted roughly that width LEFT of the words —
//  inverting cells inside the rail — while the actual match kept only the
//  shared inverse styling: stepping through matches moved a highlighted
//  block along the left edge of the screen.
//
//  THE LAW: positions are element-relative in BOTH axes; the overlay
//  translates by the element's screen-top AND screen-left. The left comes
//  from elementScreenLeft — computed lefts summed up the parent chain, the
//  same accumulation the compose walk performs from the root.
//
//   §1 the geometry law, end to end on composed screens: scan col + the
//      element's screen-left == the column the full compose actually put
//      the text at;
//   §2 THE DEFECT PIN: the styled cells land exactly on the words on the
//      full screen — and the un-translated apply (the base behaviour, kept
//      as the control) lands them in the rail;
//   §3 the seek path populates colOffset from elementScreenLeft.
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-search-highlight-column.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const { createNode, appendChildNode, createTextNode } = await import(join(ROOT, 'src/ink/dom.ts'))
const composeTree = (await import(join(ROOT, 'src/ink/compose-walk.ts'))).default
const ComposeBuffer = (await import(join(ROOT, 'src/ink/compose-buffer.ts'))).default
const { createScreen, cellAt } = await import(join(ROOT, 'src/ink/cell-grid.ts'))
const { applyPositionedHighlight, scanPositions } = await import(join(ROOT, 'src/ink/render-to-screen.ts'))
const { elementScreenLeft } = await import(join(ROOT, 'src/ink/measure-element.ts'))
const { applySceneStyle, makeContext, screenLines } = await import(join(ROOT, 'scripts/ink-runtime/frameHarness.ts'))

const COLS = 60
const ROWS = 8

// The cockpit's shape in miniature: a lanes rail, then a bordered centre
// column whose message text is what search scans.
const ctx = makeContext()
const root = createNode('ink-root')
applySceneStyle(root as never, { width: COLS, height: ROWS, flexDirection: 'row' })
const rail = createNode('ink-box')
applySceneStyle(rail as never, { width: 10, height: ROWS, flexShrink: 0 })
const railText = createNode('ink-text')
appendChildNode(railText, createTextNode('lane lane'))
appendChildNode(rail, railText)
appendChildNode(root, rail)
const centre = createNode('ink-box')
applySceneStyle(centre as never, { flexGrow: 1, height: ROWS, paddingLeft: 2, flexDirection: 'column' })
const message = createNode('ink-box')
applySceneStyle(message as never, { flexDirection: 'column' })
const msgText = createNode('ink-text')
appendChildNode(msgText, createTextNode('the needle sits here'))
appendChildNode(message, msgText)
appendChildNode(centre, message)
appendChildNode(root, centre)
root.layoutNode!.calculateLayout(COLS, ROWS)

const composeAt = (el: typeof root, w: number, h: number, offsetX: number, offsetY: number) => {
  const screen = createScreen(w, h, ctx.stylePool, ctx.charPool, ctx.hyperlinkPool)
  const buffer = new ComposeBuffer({ width: w, height: h, stylePool: ctx.stylePool, screen })
  composeTree(el as never, buffer as never, { offsetX, offsetY, prevScreen: undefined })
  return buffer.get()
}

section('§1 the geometry law: scan col + screen-left == the composed column')
const full = composeAt(root, COLS, ROWS, 0, 0)
const fullLine = screenLines(full)[0]!
const composedCol = fullLine.indexOf('needle')
check('fixture: the full compose puts the message right of the rail', composedCol > 10, j({ fullLine, composedCol }))
// The scan, exactly as scanElementSubtree performs it: the message subtree
// composed to its own screen at offsetX −left / offsetY −top.
const mLayout = message.layoutNode!
const scanScreen = composeAt(
  message,
  Math.ceil(mLayout.getComputedWidth()),
  Math.ceil(mLayout.getComputedHeight()),
  -mLayout.getComputedLeft(),
  -mLayout.getComputedTop(),
)
const positions = scanPositions(scanScreen, 'needle')
check('the scan finds the match, element-relative', positions.length === 1 && positions[0]!.col === 4, j(positions))
const left = elementScreenLeft(message as never)
check('elementScreenLeft is the missing translation: scan col + left == composed col', positions[0]!.col + left === composedCol, j({ scanCol: positions[0]!.col, left, composedCol }))

section('§2 the defect pin: the styled cells land ON the words — never in the rail')
{
  const before = Array.from({ length: COLS }, (_, x) => cellAt(full, x, 0)?.styleId)
  const applied = applyPositionedHighlight(full, ctx.stylePool, positions, 0, left, 0)
  const changed: number[] = []
  for (let x = 0; x < COLS; x++) if (cellAt(full, x, 0)?.styleId !== before[x]) changed.push(x)
  check('the overlay applied', applied === true)
  check(
    'THE DEFECT PIN: the current-match block covers exactly the match on screen',
    changed.length === positions[0]!.len && changed[0] === composedCol,
    j({ changed, composedCol }),
  )
  // The base behaviour, kept as the CONTROL: an un-translated apply paints
  // the block into the rail — the width of rail+padding left of the words.
  const full2 = composeAt(root, COLS, ROWS, 0, 0)
  const before2 = Array.from({ length: COLS }, (_, x) => cellAt(full2, x, 0)?.styleId)
  applyPositionedHighlight(full2, ctx.stylePool, positions, 0, 0, 0)
  const changed2: number[] = []
  for (let x = 0; x < COLS; x++) if (cellAt(full2, x, 0)?.styleId !== before2[x]) changed2.push(x)
  check('CONTROL (the disease): a zero col-offset lands the block in the rail, left of the words', changed2.length > 0 && changed2[0] === positions[0]!.col && changed2[0]! < 10, j({ changed2 }))
}

section('§3 the seek path populates the column offset')
{
  const vml = readFileSync(join(ROOT, 'src/components/VirtualMessageList.tsx'), 'utf8')
  check('VirtualMessageList hands the overlay the scanned element’s screen-left', vml.includes('colOffset: elementScreenLeft(el)'))
  const overlay = readFileSync(join(ROOT, 'src/ink/root/overlay-pass.ts'), 'utf8')
  check('the overlay pass carries colOffset into the apply', overlay.includes('sp.rowOffset, sp.colOffset, sp.currentIdx'))
}

console.log(failures === 0 ? '\nprove-search-highlight-column: ALL LAWS HOLD' : `\nprove-search-highlight-column: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
