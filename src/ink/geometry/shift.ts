import type { Screen } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { extractRowText } from './extract.js'
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

function shiftSpan(s: SelectionState, delta: number, min: number, max: number, width?: number): void {
  const span = s.anchorSpan
  if (!span) return
  const translate = (point: Point): Point => {
    const row = point.row + delta
    const col = width === undefined ? point.col : row < min ? 0 : row > max ? width - 1 : point.col
    const target = width === undefined ? clamp(row, min, max) : row < min ? min : row > max ? max : row
    return { col, row: target }
  }
  s.anchorSpan = { lo: translate(span.lo), hi: translate(span.hi), kind: span.kind }
}

export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  if (!s.anchor || !s.focus) return
  const anchor = rawRow(s, 'anchor', s.anchor)
  const focus = rawRow(s, 'focus', s.focus)
  const nextAnchor = anchor + dRow
  const nextFocus = focus + dRow
  if (pastSameEdge(nextAnchor, nextFocus, minRow, maxRow)) {
    clearSelection(s)
    return
  }
  const beforeAbove = Math.max(0, minRow - Math.min(anchor, focus))
  const beforeBelow = Math.max(0, Math.max(anchor, focus) - maxRow)
  const afterAbove = Math.max(0, minRow - Math.min(nextAnchor, nextFocus))
  const afterBelow = Math.max(0, Math.max(nextAnchor, nextFocus) - maxRow)
  popForDebtShrink(s, beforeAbove - afterAbove, 'above')
  popForDebtShrink(s, beforeBelow - afterBelow, 'below')
  truncateToDebt(s, afterAbove, 'above')
  truncateToDebt(s, afterBelow, 'below')
  moveEnd(s, 'anchor', nextAnchor, minRow, maxRow, width)
  moveEnd(s, 'focus', nextFocus, minRow, maxRow, width)
  shiftSpan(s, dRow, minRow, maxRow, width)
}

export function shiftAnchor(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): void {
  if (!s.anchor) return
  moveEnd(s, 'anchor', rawRow(s, 'anchor', s.anchor) + dRow, minRow, maxRow)
  shiftSpan(s, dRow, minRow, maxRow)
}

export function shiftSelectionForFollow(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): boolean {
  if (!s.anchor) return false
  const anchor = rawRow(s, 'anchor', s.anchor) + dRow
  const focus = s.focus ? rawRow(s, 'focus', s.focus) + dRow : undefined
  if (pastSameEdge(anchor, focus, minRow, maxRow)) {
    clearSelection(s)
    return true
  }
  moveEnd(s, 'anchor', anchor, minRow, maxRow)
  if (focus !== undefined) moveEnd(s, 'focus', focus, minRow, maxRow)
  else s.virtualFocusRow = undefined
  shiftSpan(s, dRow, minRow, maxRow)
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
  if (!bounds || firstRow > lastRow) return
  const first = Math.max(firstRow, bounds.start.row)
  const last = Math.min(lastRow, bounds.end.row)
  if (first > last) return
  const texts: string[] = []
  const joins: boolean[] = []
  for (let row = first; row <= last; row++) {
    const left = Math.max(row === bounds.start.row ? bounds.start.col : 0, s.clipLo ?? 0)
    const right = Math.min(row === bounds.end.row ? bounds.end.col : screen.width - 1, s.clipHi ?? screen.width - 1)
    texts.push(right >= left ? extractRowText(screen, row, left, right) : '')
    joins.push(screen.softWrap[row]! !== 0)
  }
  pushCaptured(s, texts, joins, side)
  const boundary = side === 'above' ? bounds.start.row : bounds.end.row
  const capturedBoundary = side === 'above' ? first : last
  if (!s.anchor || s.anchor.row !== boundary || capturedBoundary !== boundary) return
  s.anchor = { col: side === 'above' ? 0 : screen.width - 1, row: s.anchor.row }
  if (s.anchorSpan) {
    s.anchorSpan = {
      kind: s.anchorSpan.kind,
      lo: { col: 0, row: s.anchorSpan.lo.row },
      hi: { col: screen.width - 1, row: s.anchorSpan.hi.row },
    }
  }
}
