import type { Screen, StylePool } from '../cell-grid.js'
import { cellAtIndex, setCellStyleId } from '../cell-grid.js'
import { selectionBounds, type SelectionState } from './selection-model.js'

export function applySelectionOverlay(
  screen: Screen,
  selection: SelectionState,
  stylePool: StylePool,
): void {
  const b = selectionBounds(selection)
  if (!b) return
  const { start, end } = b
  const width = screen.width
  const noSelect = screen.noSelect
  const clipLo = selection.clipLo ?? 0
  const clipHi = selection.clipHi ?? width - 1
  for (let row = start.row; row <= end.row && row < screen.height; row++) {
    const colStart = Math.max(row === start.row ? start.col : 0, clipLo)
    const colEnd = Math.min(row === end.row ? Math.min(end.col, width - 1) : width - 1, clipHi)
    const rowOff = row * width
    for (let col = colStart; col <= colEnd; col++) {
      const idx = rowOff + col
      if (noSelect[idx] === 1) continue
      const cell = cellAtIndex(screen, idx)
      setCellStyleId(screen, col, row, stylePool.withSelectionBg(cell.styleId))
    }
  }
}
