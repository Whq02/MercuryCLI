import type { Screen } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { extractRowText } from './selectedText.js'
import { popForDebtShrink, pushCaptured, truncateToDebt } from './offscreen-ledger.js'
import { clearSelection, type Point, selectionBounds, type SelectionState } from './selection-model.js'

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

function movePoint(point: Point, dRow: number, min: number, max: number, width?: number): Point {
  const raw = point.row + dRow
  const col = width === undefined ? point.col : raw < min ? 0 : raw > max ? width - 1 : point.col
  return { col, row: clamp(raw, min, max) }
}

function moveSpan(s: SelectionState, dRow: number, min: number, max: number, width?: number): void {
  if (!s.anchorSpan) return
  s.anchorSpan = {
    lo: movePoint(s.anchorSpan.lo, dRow, min, max, width),
    hi: movePoint(s.anchorSpan.hi, dRow, min, max, width),
    kind: s.anchorSpan.kind,
  }
}

export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  if (!s.anchor || !s.focus) return
  const oldAnchor = rawRow(s, 'anchor', s.anchor)
  const oldFocus = rawRow(s, 'focus', s.focus)
  const newAnchor = oldAnchor + dRow
  const newFocus = oldFocus + dRow
  if (pastSameEdge(newAnchor, newFocus, minRow, maxRow)) {
    clearSelection(s)
    return
  }
  moveEnd(s, 'anchor', newAnchor, minRow, maxRow, width)
  moveEnd(s, 'focus', newFocus, minRow, maxRow, width)
  moveSpan(s, dRow, minRow, maxRow, width)
  const oldAbove = Math.max(0, minRow - Math.min(oldAnchor, oldFocus))
  const oldBelow = Math.max(0, Math.max(oldAnchor, oldFocus) - maxRow)
  const newAbove = Math.max(0, minRow - Math.min(newAnchor, newFocus))
  const newBelow = Math.max(0, Math.max(newAnchor, newFocus) - maxRow)
  popForDebtShrink(s, oldAbove - newAbove, 'above')
  popForDebtShrink(s, oldBelow - newBelow, 'below')
  truncateToDebt(s, newAbove, 'above')
  truncateToDebt(s, newBelow, 'below')
}

export function shiftAnchor(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): void {
  if (!s.anchor) return
  moveEnd(s, 'anchor', rawRow(s, 'anchor', s.anchor) + dRow, minRow, maxRow)
  moveSpan(s, dRow, minRow, maxRow)
}

export function shiftSelectionForFollow(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): boolean {
  if (!s.anchor) return false
  const newAnchor = rawRow(s, 'anchor', s.anchor) + dRow
  const newFocus = s.focus ? rawRow(s, 'focus', s.focus) + dRow : undefined
  if (pastSameEdge(newAnchor, newFocus, minRow, maxRow)) {
    clearSelection(s)
    return true
  }
  moveEnd(s, 'anchor', newAnchor, minRow, maxRow)
  if (newFocus !== undefined) moveEnd(s, 'focus', newFocus, minRow, maxRow)
  else s.virtualFocusRow = undefined
  moveSpan(s, dRow, minRow, maxRow)
  return false
}

export function captureScrolledRows(
  s: SelectionState,
  screen: Screen,
  firstRow: number,
  lastRow: number,
  side: 'above' | 'below',
): void {
  const bounds = selectionBounds(s)
  if (!bounds) return
  const lo = Math.max(firstRow, bounds.start.row)
  const hi = Math.min(lastRow, bounds.end.row)
  if (lo > hi) return
  const bandLo = s.clipLo ?? 0
  const bandHi = s.clipHi ?? screen.width - 1
  const rows: string[] = []
  const softWrapBits: boolean[] = []
  for (let row = lo; row <= hi; row++) {
    const colStart = Math.max(row === bounds.start.row ? bounds.start.col : 0, bandLo)
    const colEnd = Math.min(row === bounds.end.row ? bounds.end.col : screen.width - 1, bandHi)
    rows.push(colStart <= colEnd ? extractRowText(screen, row, colStart, colEnd) : '')
    softWrapBits.push((screen.softWrap[row] ?? 0) !== 0)
  }
  pushCaptured(s, rows, softWrapBits, side)
  if (side === 'above') {
    if (s.anchor && s.anchor.row === bounds.start.row && lo === bounds.start.row) {
      s.anchor = { col: 0, row: s.anchor.row }
      if (s.anchorSpan) {
        s.anchorSpan = {
          lo: { col: 0, row: s.anchorSpan.lo.row },
          hi: { col: screen.width - 1, row: s.anchorSpan.hi.row },
          kind: s.anchorSpan.kind,
        }
      }
    }
  } else if (s.anchor && s.anchor.row === bounds.end.row && hi === bounds.end.row) {
    s.anchor = { col: screen.width - 1, row: s.anchor.row }
    if (s.anchorSpan) {
      s.anchorSpan = {
        lo: { col: 0, row: s.anchorSpan.lo.row },
        hi: { col: screen.width - 1, row: s.anchorSpan.hi.row },
        kind: s.anchorSpan.kind,
      }
    }
  }
}
