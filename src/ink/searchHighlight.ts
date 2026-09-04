
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

export function buildRowText(screen: Screen, y: number): RowText {
  const cellColumns: number[] = []
  const unitToContribution: number[] = []
  let text = ''
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y)
    if (!cell) continue
    if (skipCell(screen, x, y, cell.width)) continue
    const char = cell.char
    if (char === '') continue
    const lowered = char.toLowerCase()
    const contribution = cellColumns.length
    cellColumns.push(x)
    for (let i = 0; i < lowered.length; i++) {
      unitToContribution.push(contribution)
    }
    text += lowered
  }
  return { text, cellColumns, unitToContribution }
}

export function applySearchHighlight(
  screen: Screen,
  query: string,
  stylePool: StylePool,
  record?: OverlayRecord,
): boolean {
  if (!query) return false
  const needle = query.toLowerCase()
  let applied = false
  for (let y = 0; y < screen.height; y++) {
    const row = buildRowText(screen, y)
    if (row.text.length < needle.length) continue
    let from = 0
    for (;;) {
      const index = row.text.indexOf(needle, from)
      if (index === -1) break
      from = index + needle.length
      const firstContribution = row.unitToContribution[index]
      const lastContribution = row.unitToContribution[index + needle.length - 1]
      if (firstContribution === undefined || lastContribution === undefined) {
        continue
      }
      const firstColumn = row.cellColumns[firstContribution]!
      const lastColumn = row.cellColumns[lastContribution]!
      for (let x = firstColumn; x <= lastColumn; x++) {
        const cell = cellAt(screen, x, y)
        if (!cell) continue
        restyleCell(screen, x, y, stylePool.withInverse(cell.styleId), record)
      }
      applied = true
    }
  }
  return applied
}
