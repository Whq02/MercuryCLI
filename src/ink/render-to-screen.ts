import { cellAt, CellWidth, StylePool, type Screen } from './cell-grid.js'
import { restyleCell, type OverlayRecord } from './geometry/overlay.js'
import { notBuilt } from '../pi/holes.js'

export type MatchPosition = { row: number; col: number; len: number }

type SearchableRow = { lowered: string; columnOfRun: number[]; runOfUnit: number[] }

function searchableRow(grid: Screen, row: number): SearchableRow {
  return notBuilt('src/ink/render-to-screen.ts:8')
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
  return notBuilt('src/ink/render-to-screen.ts:47')
}

export function applyPositionedHighlight(grid: Screen, styles: StylePool, positions: MatchPosition[], rowOffset: number, colOffset: number, selected: number, record?: OverlayRecord): boolean {
  return notBuilt('src/ink/render-to-screen.ts:55')
}
