import { cellAt, CellWidth, StylePool, type Screen } from './cell-grid.js'
import { restyleCell, type OverlayRecord } from './geometry/overlay.js'

export type MatchPosition = { row: number; col: number; len: number }

type SearchableRow = { lowered: string; columnOfRun: number[]; runOfUnit: number[] }

function searchableRow(grid: Screen, row: number): SearchableRow {
  let lowered = ''
  const columnOfRun: number[] = []
  const runOfUnit: number[] = []
  const rowBase = row * grid.width
  for (let col = 0; col < grid.width; col++) {
    if (grid.noSelect[rowBase + col] !== 0) continue
    const cell = cellAt(grid, col, row)
    if (!cell) continue
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
    if (!cell.char) continue
    const piece = cell.char.toLowerCase()
    if (!piece) continue
    const run = columnOfRun.length
    columnOfRun.push(col)
    lowered += piece
    for (let u = 0; u < piece.length; u++) runOfUnit.push(run)
  }
  return { lowered, columnOfRun, runOfUnit }
}

function matchesInRow(grid: Screen, row: number, needle: string): MatchPosition[] {
  const hits: MatchPosition[] = []
  const line = searchableRow(grid, row)
  if (line.lowered.length < needle.length) return hits
  let scanFrom = 0
  for (;;) {
    const at = line.lowered.indexOf(needle, scanFrom)
    if (at === -1) break
    scanFrom = at + needle.length
    const firstRun = line.runOfUnit[at]
    const lastRun = line.runOfUnit[scanFrom - 1]
    if (firstRun === undefined || lastRun === undefined) continue
    const firstColumn = line.columnOfRun[firstRun]!
    const lastColumn = line.columnOfRun[lastRun]!
    const lastCellWidth = cellAt(grid, lastColumn, row)?.width === CellWidth.Wide ? 2 : 1
    hits.push({ row, col: firstColumn, len: lastColumn + lastCellWidth - firstColumn })
  }
  return hits
}

export function scanPositions(grid: Screen, query: string): MatchPosition[] {
  if (!query) return []
  const needle = query.toLowerCase()
  const positions: MatchPosition[] = []
  for (let row = 0; row < grid.height; row++) {
    positions.push(...matchesInRow(grid, row, needle))
  }
  return positions
}

export function applyPositionedHighlight(
  grid: Screen,
  styles: StylePool,
  positions: MatchPosition[],
  rowOffset: number,
  colOffset: number,
  selected: number,
  record?: OverlayRecord,
): boolean {
  if (selected < 0 || selected >= positions.length) return false
  const match = positions[selected]
  if (!match) return false
  const row = match.row + rowOffset
  if (row < 0 || row >= grid.height) return false
  const startCol = Math.max(0, match.col + colOffset)
  const endCol = Math.min(grid.width, match.col + colOffset + match.len)
  if (startCol >= endCol) return false
  for (let col = startCol; col < endCol; col++) {
    const cell = cellAt(grid, col, row)
    if (!cell) continue
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
    restyleCell(grid, col, row, styles.withCurrentMatch(cell.styleId), record)
  }
  return true
}
