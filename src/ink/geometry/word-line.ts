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

export function wordBoundsAt(
  screen: Screen,
  col: number,
  row: number,
): { lo: number; hi: number } | null {
  if (row < 0 || row >= screen.height) return null
  const origin = col > 0 && cellAt(screen, col, row)?.width === CellWidth.SpacerTail ? col - 1 : col
  if (origin < 0 || origin >= screen.width || screen.noSelect[row * screen.width + origin] === 1) return null
  const cell = cellAt(screen, origin, row)
  if (!cell) return null
  const kind = charClass(cell.char)
  return { lo: runEdge(screen, row, origin, -1, kind), hi: runEdge(screen, row, origin, 1, kind) }
}

function beginSpan(s: SelectionState, lo: Point, hi: Point, kind: 'word' | 'line'): void {
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind }
}

export function selectWordAt(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  const bounds = wordBoundsAt(screen, col, row)
  if (bounds) beginSpan(s, { col: bounds.lo, row }, { col: bounds.hi, row }, 'word')
}

export function selectLineAt(s: SelectionState, screen: Screen, row: number): void {
  if (row < 0 || row >= screen.height) return
  beginSpan(s, { col: 0, row }, { col: screen.width - 1, row }, 'line')
}

export function extendSelection(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  const span = s.anchorSpan
  if (!s.isDragging || !span) return
  const targetRow = span.kind === 'line' ? clamp(row, 0, screen.height - 1) : row
  const bounds = span.kind === 'word'
    ? wordBoundsAt(screen, col, row) ?? { lo: col, hi: col }
    : { lo: 0, hi: screen.width - 1 }
  const first = { col: bounds.lo, row: targetRow }
  const last = { col: bounds.hi, row: targetRow }
  const before = comparePoints(last, span.lo) < 0
  const after = !before && comparePoints(first, span.hi) > 0
  s.anchor = before ? span.hi : span.lo
  s.focus = before ? first : after ? last : span.hi
}
