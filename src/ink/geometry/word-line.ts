import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { comparePoints, type Point, type SelectionState } from './selection-model.js'

const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

function charClass(text: string): 0 | 1 | 2 {
  return text === ' ' || text === '' ? 0 : WORD_CHAR.test(text) ? 1 : 2
}

function runEdge(screen: Screen, row: number, origin: number, step: -1 | 1, kind: number): number {
  const rowStart = row * screen.width
  let edge = origin
  while (true) {
    let next = edge + step
    if (next < 0 || next >= screen.width || screen.noSelect[rowStart + next] === 1) return edge
    let cell = cellAt(screen, next, row)
    if (!cell) return edge
    if (cell.width === CellWidth.SpacerTail) {
      if (step === 1) {
        edge = next
        continue
      }
      next--
      if (next < 0 || screen.noSelect[rowStart + next] === 1) return edge
      cell = cellAt(screen, next, row)
      if (!cell) return edge
    }
    if (charClass(cell.char) !== kind) return edge
    edge = next
  }
}

function beginSpan(s: SelectionState, loCol: number, hiCol: number, row: number, kind: 'word' | 'line'): void {
  const lo: Point = { col: loCol, row }
  const hi: Point = { col: hiCol, row }
  s.anchor = { ...lo }
  s.focus = { ...hi }
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind }
}

export function wordBoundsAt(
  screen: Screen,
  col: number,
  row: number,
): { lo: number; hi: number } | null {
  if (row < 0 || row >= screen.height || col < 0 || col >= screen.width) return null
  let origin = col
  let cell = cellAt(screen, origin, row)
  if (!cell) return null
  if (cell.width === CellWidth.SpacerTail) {
    origin--
    if (origin < 0) return null
    cell = cellAt(screen, origin, row)
    if (!cell) return null
  }
  if (screen.noSelect[row * screen.width + origin] === 1) return null
  const kind = charClass(cell.char)
  return {
    lo: runEdge(screen, row, origin, -1, kind),
    hi: runEdge(screen, row, origin, 1, kind),
  }
}

export function selectWordAt(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  const bounds = wordBoundsAt(screen, col, row)
  if (!bounds) return
  beginSpan(s, bounds.lo, bounds.hi, row, 'word')
}

export function selectLineAt(s: SelectionState, screen: Screen, row: number): void {
  if (row < 0 || row >= screen.height) return
  beginSpan(s, 0, screen.width - 1, row, 'line')
}

export function extendSelection(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  if (!s.isDragging || !s.anchorSpan) return
  const span = s.anchorSpan
  const targetRow = span.kind === 'line' ? clamp(row, 0, screen.height - 1) : row
  const bounds =
    span.kind === 'line'
      ? { lo: 0, hi: screen.width - 1 }
      : (wordBoundsAt(screen, col, targetRow) ?? { lo: col, hi: col })
  const first: Point = { col: bounds.lo, row: targetRow }
  const last: Point = { col: bounds.hi, row: targetRow }
  if (comparePoints(first, span.lo) < 0) {
    s.anchor = { ...span.hi }
    s.focus = first
  } else if (comparePoints(last, span.hi) > 0) {
    s.anchor = { ...span.lo }
    s.focus = last
  } else {
    s.anchor = { ...span.lo }
    s.focus = { ...span.hi }
  }
}
