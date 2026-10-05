import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { selectionBounds, type SelectionState } from './selection-model.js'

export function extractRowText(
  screen: Screen,
  row: number,
  colStart: number,
  colEnd: number,
): string {
  const continuation = row + 1 < screen.height ? screen.softWrap[row + 1]! : 0
  const end = continuation > 0 ? Math.min(colEnd, continuation - 1) : colEnd
  const offset = row * screen.width
  let text = ''
  for (let column = colStart; column <= end; column++) {
    if (screen.noSelect[offset + column] === 1) continue
    const cell = cellAt(screen, column, row)
    if (cell && cell.width !== CellWidth.SpacerHead && cell.width !== CellWidth.SpacerTail) text += cell.char
  }
  return continuation > 0 ? text : text.replace(/\s+$/, '')
}

export function joinRows(lines: string[], text: string, sw: boolean | undefined): void {
  const previous = lines.length - 1
  if (!sw || previous < 0) lines.push(text)
  else lines[previous] += text
}

function appendCaptured(lines: string[], rows: readonly string[], joins: readonly boolean[]): void {
  for (let index = 0; index < rows.length; index++) joinRows(lines, rows[index]!, joins[index])
}

export function getSelectedText(s: SelectionState, screen: Screen): string {
  const bounds = selectionBounds(s)
  if (!bounds) return ''
  const lines: string[] = []
  appendCaptured(lines, s.scrolledOffAbove, s.scrolledOffAboveSW)
  const { start, end } = bounds
  const firstRow = Math.max(start.row, s.clipTop ?? 0)
  const lastRow = Math.min(end.row, s.clipBottom ?? screen.height - 1)
  for (let row = firstRow; row <= lastRow; row++) {
    const firstColumn = Math.max(row === start.row ? start.col : 0, s.clipLo ?? 0)
    const lastColumn = Math.min(row === end.row ? end.col : screen.width - 1, s.clipHi ?? screen.width - 1)
    if (lastColumn < firstColumn) continue
    const continuation = screen.softWrap[row]!
    const joins = continuation > 0 || (continuation < 0 && row === start.row && lines.length > 0)
    joinRows(lines, extractRowText(screen, row, firstColumn, lastColumn), joins)
  }
  appendCaptured(lines, s.scrolledOffBelow, s.scrolledOffBelowSW)
  return lines.join('\n')
}
