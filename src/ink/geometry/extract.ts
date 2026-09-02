import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { selectionBounds, type SelectionState } from './selection-model.js'

export function extractRowText(
  screen: Screen,
  row: number,
  colStart: number,
  colEnd: number,
): string {
  const noSelect = screen.noSelect
  const rowOff = row * screen.width
  const contentEnd = row + 1 < screen.height ? screen.softWrap[row + 1]! : 0
  const lastCol = contentEnd > 0 ? Math.min(colEnd, contentEnd - 1) : colEnd
  let line = ''
  for (let col = colStart; col <= lastCol; col++) {
    if (noSelect[rowOff + col] === 1) continue
    const cell = cellAt(screen, col, row)
    if (!cell) continue
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) {
      continue
    }
    line += cell.char
  }
  return contentEnd > 0 ? line : line.replace(/\s+$/, '')
}

export function joinRows(lines: string[], text: string, sw: boolean | undefined): void {
  if (sw && lines.length > 0) {
    lines[lines.length - 1] += text
  } else {
    lines.push(text)
  }
}

export function getSelectedText(s: SelectionState, screen: Screen): string {
  const b = selectionBounds(s)
  if (!b) return ''
  const { start, end } = b
  const sw = screen.softWrap
  const lines: string[] = []

  for (let i = 0; i < s.scrolledOffAbove.length; i++) {
    joinRows(lines, s.scrolledOffAbove[i]!, s.scrolledOffAboveSW[i])
  }

  const lo = s.clipLo ?? 0
  const hi = s.clipHi ?? screen.width - 1
  for (let row = start.row; row <= end.row; row++) {
    const rowStart = Math.max(row === start.row ? start.col : 0, lo)
    const rowEnd = Math.min(row === end.row ? end.col : screen.width - 1, hi)
    if (rowEnd < rowStart) continue
    const swVal = sw[row]!
    const joins = swVal > 0 || (swVal < 0 && row === start.row && lines.length > 0)
    joinRows(lines, extractRowText(screen, row, rowStart, rowEnd), joins)
  }

  for (let i = 0; i < s.scrolledOffBelow.length; i++) {
    joinRows(lines, s.scrolledOffBelow[i]!, s.scrolledOffBelowSW[i])
  }

  return lines.join('\n')
}
