#!/usr/bin/env bun
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)

const { createNode, appendChildNode, createTextNode } = await import(join(ROOT, 'src/screen/renderer/dom.ts'))
const composeTree = (await import(join(ROOT, 'src/screen/renderer/compose-walk.ts'))).default
const ComposeBuffer = (await import(join(ROOT, 'src/screen/renderer/compose-buffer.ts'))).default
const { createScreen, cellAt } = await import(join(ROOT, 'src/screen/renderer/cell-grid.ts'))
const { applyPositionedHighlight, scanPositions } = await import(join(ROOT, 'src/screen/renderer/matchPositions.ts'))
const { elementScreenLeft } = await import(join(ROOT, 'src/screen/renderer/measure-element.ts'))
const { applySceneStyle, makeContext, screenLines } = await import(join(ROOT, 'scripts/ink-runtime/frameHarness.ts'))

const COLS = 60
const ROWS = 8

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
check('fixture: the full compose puts the message right of the rail', composedCol > 10, `${j({ fullLine, composedCol })} — the fixture layout changed: the full compose (src/screen/renderer/compose-walk.ts) no longer puts the message right of the 10-column rail`)
const mLayout = message.layoutNode!
const scanScreen = composeAt(
  message,
  Math.ceil(mLayout.getComputedWidth()),
  Math.ceil(mLayout.getComputedHeight()),
  -mLayout.getComputedLeft(),
  -mLayout.getComputedTop(),
)
const positions = scanPositions(scanScreen, 'needle')
check('the scan finds the match, element-relative', positions.length === 1 && positions[0]!.col === 4, `${j(positions)} — scanPositions in src/screen/renderer/matchPositions.ts must return one match whose col is relative to the element`)
const left = elementScreenLeft(message as never)
check('elementScreenLeft is the missing translation: scan col + left == composed col', positions[0]!.col + left === composedCol, `${j({ scanCol: positions[0]!.col, left, composedCol })} — elementScreenLeft in src/screen/renderer/measure-element.ts must return the element's screen-left column so scan col plus left equals the composed column`)

section('§2 the defect pin: the styled cells land ON the words — never in the rail')
{
  const before = Array.from({ length: COLS }, (_, x) => cellAt(full, x, 0)?.styleId)
  const applied = applyPositionedHighlight(full, ctx.stylePool, positions, 0, left, 0)
  const changed: number[] = []
  for (let x = 0; x < COLS; x++) if (cellAt(full, x, 0)?.styleId !== before[x]) changed.push(x)
  check('the overlay applied', applied === true, 'applyPositionedHighlight in src/screen/renderer/matchPositions.ts returned false for the scanned position')
  check(
    'THE DEFECT PIN: the current-match block covers exactly the match on screen',
    changed.length === positions[0]!.len && changed[0] === composedCol,
    `${j({ changed, composedCol })} — applyPositionedHighlight in src/screen/renderer/matchPositions.ts must style exactly the matched cells at scan col plus the colOffset passed from elementScreenLeft`,
  )
  const full2 = composeAt(root, COLS, ROWS, 0, 0)
  const before2 = Array.from({ length: COLS }, (_, x) => cellAt(full2, x, 0)?.styleId)
  applyPositionedHighlight(full2, ctx.stylePool, positions, 0, 0, 0)
  const changed2: number[] = []
  for (let x = 0; x < COLS; x++) if (cellAt(full2, x, 0)?.styleId !== before2[x]) changed2.push(x)
  check('CONTROL (the disease): a zero col-offset lands the block in the rail, left of the words', changed2.length > 0 && changed2[0] === positions[0]!.col && changed2[0]! < 10, `${j({ changed2 })} — with colOffset 0 applyPositionedHighlight in src/screen/renderer/matchPositions.ts must style at the scan col, which is the rail; the control no longer reproduces the defect`)
}


console.log(failures === 0 ? '\nprove-search-highlight-column: ALL LAWS HOLD' : `\nprove-search-highlight-column: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
