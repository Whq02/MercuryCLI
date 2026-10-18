import { cellAt, CellWidth, StylePool, type Screen } from './cell-grid.js'
import { restyleCell, type OverlayRecord } from './geometry/overlay.js'

export type MatchPosition = { row: number; col: number; len: number }

type SearchableRow = { lowered: string; columnOfRun: number[]; runOfUnit: number[] }

function searchableRow(grid: Screen, row: number): SearchableRow {
  const columnOfRun: number[] = []
  const runOfUnit: number[] = []
  const pieces: string[] = []
  const rowStart = row * grid.width
  for (let column = 0; column < grid.width; column++) {
    const cell = cellAt(grid, column, row)
    if (cell === undefined || cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) continue
    if (grid.noSelect[rowStart + column] !== 0) continue
    const glyph = cell.char.toLowerCase()
    if (glyph.length === 0) continue
    const run = columnOfRun.length
    columnOfRun.push(column)
    for (let unit = 0; unit < glyph.length; unit++) runOfUnit.push(run)
    pieces.push(glyph)
  }
  return { lowered: pieces.join(''), columnOfRun, runOfUnit }
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
  const hits: MatchPosition[] = []
  for (let row = 0; row < grid.height; row++) hits.push(...matchesInRow(grid, row, needle))
  return hits
}

export function applyPositionedHighlight(grid: Screen, styles: StylePool, positions: MatchPosition[], rowOffset: number, colOffset: number, selected: number, record?: OverlayRecord): boolean {
  if (selected < 0 || selected >= positions.length) return false
  const match = positions[selected]!
  const row = match.row + rowOffset
  const left = Math.max(0, match.col + colOffset)
  const right = Math.min(grid.width, match.col + colOffset + match.len)
  const paints = row >= 0 && row < grid.height && right > left
  if (paints) {
    for (let column = left; column < right; column++) {
      const cell = cellAt(grid, column, row)
      if (cell !== undefined) restyleCell(grid, column, row, styles.withCurrentMatch(cell.styleId), record)
    }
  }
  return paints
}
