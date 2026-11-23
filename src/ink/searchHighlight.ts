import {
  cellAt,
  CellWidth,
  type Screen,
  type StylePool,
} from './cell-grid.js'
import { restyleCell, type OverlayRecord } from './geometry/overlay.js'

type RowText = {
  text: string
  cellColumns: number[]
  unitToContribution: number[]
}

function skipCell(screen: Screen, x: number, y: number, width: CellWidth): boolean {
  if (width === CellWidth.SpacerTail) return true
  if (width === CellWidth.SpacerHead) return true
  return screen.noSelect[y * screen.width + x] !== 0
}

function readRowText(screen: Screen, y: number): RowText {
  let text = ''
  const cellColumns: number[] = []
  const unitToContribution: number[] = []
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y)
    if (!cell || skipCell(screen, x, y, cell.width)) continue
    if (cell.char === '') continue
    const lower = cell.char.toLowerCase()
    const contribution = cellColumns.length
    cellColumns.push(x)
    text += lower
    for (let i = 0; i < lower.length; i++) {
      unitToContribution.push(contribution)
    }
  }
  return { text, cellColumns, unitToContribution }
}

export function applySearchHighlight(
  screen: Screen,
  query: string,
  stylePool: StylePool,
  record?: OverlayRecord,
): boolean {
  if (query.length === 0) return false
  const needle = query.toLowerCase()
  let marked = false
  for (let y = 0; y < screen.height; y++) {
    const row = readRowText(screen, y)
    if (row.text.length < needle.length) continue
    let from = 0
    while (true) {
      const idx = row.text.indexOf(needle, from)
      if (idx === -1) break
      const startCol = row.cellColumns[row.unitToContribution[idx]!]!
      const endCol = row.cellColumns[row.unitToContribution[idx + needle.length - 1]!]!
      for (let col = startCol; col <= endCol; col++) {
        const cell = cellAt(screen, col, y)
        if (!cell) continue
        restyleCell(screen, col, y, stylePool.withInverse(cell.styleId), record)
      }
      marked = true
      from = idx + needle.length
    }
  }
  return marked
}
