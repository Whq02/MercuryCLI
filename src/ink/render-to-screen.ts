

import {
  cellAt,
  CellWidth,
  StylePool,
  type Screen,
} from './cell-grid.js'

import { restyleCell, type OverlayRecord } from './geometry/overlay.js'

export type MatchPosition = {
  row: number
  col: number
  len: number
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
