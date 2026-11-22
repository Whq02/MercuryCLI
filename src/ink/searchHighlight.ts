import {
  cellAt,
  CellWidth,
  type Screen,
  type StylePool,
} from './cell-grid.js'
import { restyleCell, type OverlayRecord } from './geometry/overlay.js'
import { notBuilt } from '../pi/holes.js'

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

export function applySearchHighlight(
  screen: Screen,
  query: string,
  stylePool: StylePool,
  record?: OverlayRecord,
): boolean {
  return notBuilt('src/ink/searchHighlight.ts:43')
}
