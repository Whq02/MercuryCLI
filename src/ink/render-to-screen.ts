
import type { ReactNode } from 'react'
import { LegacyRoot } from 'react-reconciler/constants.js'
import {
  cellAt,
  CellWidth,
  CharPool,
  createScreen,
  HyperlinkPool,
  StylePool,
  type Screen,
} from './cell-grid.js'
import ComposeBuffer from './compose-buffer.js'
import composeTree from './compose-walk.js'
import { createNode, type DOMElement } from './dom.js'
import { FocusManager } from './focus.js'
import { restyleCell, type OverlayRecord } from './geometry/overlay.js'
import reconciler from './reconciler.js'
import { logForDebugging } from '../utils/debug.js'

export type MatchPosition = {
  row: number
  col: number
  len: number
}


type OffscreenRoot = {
  rootNode: DOMElement
  container: unknown
  stylePool: StylePool
  charPool: CharPool
  hyperlinkPool: HyperlinkPool
  buffer: ComposeBuffer | null
}

let offscreen: OffscreenRoot | null = null

function getOffscreenRoot(): OffscreenRoot {
  if (offscreen) return offscreen
  const rootNode = createNode('ink-root')
  rootNode.focusManager = new FocusManager(() => {})
  const container = reconciler.createContainer(
    rootNode,
    LegacyRoot,
    null,
    false,
    null,
    '',
    () => {},
    () => {},
    () => {},
    () => {},
  )
  offscreen = {
    rootNode,
    container,
    stylePool: new StylePool(),
    charPool: new CharPool(),
    hyperlinkPool: new HyperlinkPool(),
    buffer: null,
  }
  return offscreen
}

const LOG_EVERY = 20
let calls = 0
let reconcileMs = 0
let layoutMs = 0
let paintMs = 0

export function renderToScreen(
  el: ReactNode,
  width: number,
): { screen: Screen; height: number } {
  const root = getOffscreenRoot()

  const t0 = performance.now()
  reconciler.updateContainerSync(el, root.container, null, null)
  reconciler.flushSyncWork()
  const t1 = performance.now()

  const layout = root.rootNode.layoutNode!
  layout.setWidth(width)
  layout.calculateLayout(width, undefined)
  const height =
    root.rootNode.childNodes.length === 0
      ? 0
      : Math.ceil(layout.getComputedHeight())
  const t2 = performance.now()

  const screen = createScreen(
    width,
    Math.max(1, height),
    root.stylePool,
    root.charPool,
    root.hyperlinkPool,
  )
  if (root.buffer) {
    root.buffer.reset(width, Math.max(1, height), screen)
  } else {
    root.buffer = new ComposeBuffer({
      width,
      height: Math.max(1, height),
      stylePool: root.stylePool,
      screen,
    })
  }
  composeTree(root.rootNode, root.buffer, { prevScreen: undefined })
  const composed = root.buffer.get()
  const t3 = performance.now()

  reconciler.updateContainerSync(null, root.container, null, null)
  reconciler.flushSyncWork()

  calls++
  reconcileMs += t1 - t0
  layoutMs += t2 - t1
  paintMs += t3 - t2
  if (calls % LOG_EVERY === 0) {
    logForDebugging(
      `renderToScreen: ${calls} calls, avg reconcile=${(reconcileMs / calls).toFixed(2)}ms layout=${(layoutMs / calls).toFixed(2)}ms paint=${(paintMs / calls).toFixed(2)}ms`,
    )
  }

  return { screen: composed, height }
}


function buildRow(
  screen: Screen,
  y: number,
): { text: string; cellColumns: number[]; unitToContribution: number[] } {
  const cellColumns: number[] = []
  const unitToContribution: number[] = []
  let text = ''
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y)
    if (!cell) continue
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) {
      continue
    }
    if (screen.noSelect[y * screen.width + x] !== 0) continue
    const lowered = cell.char.toLowerCase()
    if (lowered.length === 0) continue
    const contribution = cellColumns.length
    cellColumns.push(x)
    for (let i = 0; i < lowered.length; i++) unitToContribution.push(contribution)
    text += lowered
  }
  return { text, cellColumns, unitToContribution }
}

export function scanPositions(screen: Screen, query: string): MatchPosition[] {
  const positions: MatchPosition[] = []
  if (!query) return positions
  const needle = query.toLowerCase()
  for (let y = 0; y < screen.height; y++) {
    const row = buildRow(screen, y)
    if (row.text.length < needle.length) continue
    let from = 0
    for (;;) {
      const index = row.text.indexOf(needle, from)
      if (index === -1) break
      from = index + needle.length
      const first = row.unitToContribution[index]
      const last = row.unitToContribution[index + needle.length - 1]
      if (first === undefined || last === undefined) continue
      const firstColumn = row.cellColumns[first]!
      const lastColumn = row.cellColumns[last]!
      const lastCell = cellAt(screen, lastColumn, y)
      const lastWidth = lastCell?.width === CellWidth.Wide ? 2 : 1
      positions.push({
        row: y,
        col: firstColumn,
        len: lastColumn + lastWidth - firstColumn,
      })
    }
  }
  return positions
}


export function applyPositionedHighlight(
  screen: Screen,
  stylePool: StylePool,
  positions: MatchPosition[],
  rowOffset: number,
  colOffset: number,
  currentIdx: number,
  record?: OverlayRecord,
): boolean {
  if (currentIdx < 0 || currentIdx >= positions.length) return false
  const position = positions[currentIdx]!
  const row = position.row + rowOffset
  if (row < 0 || row >= screen.height) return false
  const col = position.col + colOffset
  const start = Math.max(0, col)
  const end = Math.min(screen.width, col + position.len)
  if (end <= start) return false
  for (let x = start; x < end; x++) {
    const cell = cellAt(screen, x, row)
    if (!cell) continue
    restyleCell(screen, x, row, stylePool.withCurrentMatch(cell.styleId), record)
  }
  return true
}
