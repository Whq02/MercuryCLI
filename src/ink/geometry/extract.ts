import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { selectionBounds, type SelectionState } from './selection-model.js'

export function extractRowText(
  screen: Screen,
  row: number,
  colStart: number,
  colEnd: number,
): string {
  if (row < 0 || row >= screen.height) return ''
  const continuation = row + 1 < screen.height ? (screen.softWrap[row + 1] ?? 0) : 0
  const start = Math.max(0, colStart)
  const limit = Math.min(colEnd, screen.width - 1)
  const end = continuation > 0 ? Math.min(limit, continuation - 1) : limit
  const rowStart = row * screen.width
  let text = ''
  for (let col = start; col <= end; col++) {
    if (screen.noSelect[rowStart + col] === 1) continue
    const cell = cellAt(screen, col, row)
    if (!cell || cell.width === CellWidth.SpacerHead || cell.width === CellWidth.SpacerTail) continue
    text += cell.char
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
  const firstRow = Math.max(bounds.start.row, s.clipTop ?? 0)
  const lastRow = Math.min(bounds.end.row, s.clipBottom ?? screen.height - 1)
  const bandLo = s.clipLo ?? 0
  const bandHi = s.clipHi ?? screen.width - 1
  for (let row = firstRow; row <= lastRow; row++) {
    const colStart = Math.max(row === bounds.start.row ? bounds.start.col : 0, bandLo)
    const colEnd = Math.min(row === bounds.end.row ? bounds.end.col : screen.width - 1, bandHi)
    if (colStart > colEnd) continue
    const sw = screen.softWrap[row] ?? 0
    const joins = sw > 0 || (sw < 0 && row === bounds.start.row && lines.length > 0)
    joinRows(lines, extractRowText(screen, row, colStart, colEnd), joins)
  }
  appendCaptured(lines, s.scrolledOffBelow, s.scrolledOffBelowSW)
  return lines.join('\n')
}
