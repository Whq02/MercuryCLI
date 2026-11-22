import type { Screen } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { extractRowText } from './extract.js'
import { popForDebtShrink, pushCaptured, truncateToDebt } from './offscreen-ledger.js'
import { clearSelection, type Point, selectionBounds, type SelectionState } from './selection-model.js'
import { notBuilt } from '../../pi/holes.js'

type End = 'anchor' | 'focus'

function rawRow(s: SelectionState, end: End, point: Point): number {
  return (end === 'anchor' ? s.virtualAnchorRow : s.virtualFocusRow) ?? point.row
}

function moveEnd(s: SelectionState, end: End, raw: number, min: number, max: number, width?: number): void {
  const point = s[end]
  if (!point) return
  const clipped = raw < min || raw > max
  const column = width === undefined ? point.col : raw < min ? 0 : raw > max ? width - 1 : point.col
  const row = width === undefined ? clamp(raw, min, max) : raw < min ? min : raw > max ? max : raw
  s[end] = { col: column, row }
  if (end === 'anchor') s.virtualAnchorRow = clipped ? raw : undefined
  else s.virtualFocusRow = clipped ? raw : undefined
}

function pastSameEdge(a: number, b: number | undefined, min: number, max: number): boolean {
  return b !== undefined && ((a < min && b < min) || (a > max && b > max))
}

export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  return notBuilt('src/ink/geometry/shift.ts:40')
}

export function shiftAnchor(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): void {
  return notBuilt('src/ink/geometry/shift.ts:69')
}

export function shiftSelectionForFollow(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): boolean {
  return notBuilt('src/ink/geometry/shift.ts:80')
}

export function captureScrolledRows(
  s: SelectionState,
  screen: Screen,
  firstRow: number,
  lastRow: number,
  side: 'above' | 'below',
): void {
  return notBuilt('src/ink/geometry/shift.ts:100')
}
