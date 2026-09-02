// ============================================================================
//  word-line.ts — T7: multi-click word/line selection.
//
//  Double-click expands to the same-CHARACTER-CLASS run at the cell
//  (iTerm2 semantics: word chars are letters/digits/`_/.-+~\` so a path
//  like `~/.mercury/config.json` selects whole — the muscle memory);
//  triple-click takes the row. Both arm isDragging + anchorSpan so a
//  subsequent drag extends word-by-word / line-by-line from the ORIGINAL
//  span (it stays selected even dragging backward past it).
//
//  Wide glyphs: a click on a spacer tail rebases to the head; expansion
//  steps OVER tails in both directions (the head carries the class); the
//  right edge INCLUDES the tail (it belongs to the glyph).
//  prove-geometry-contract WORD/LINE + EXTEND pin the class table and the
//  three-way extend.
// ============================================================================
import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { comparePoints, type Point, type SelectionState } from './selection-model.js'

// iTerm2's default "characters considered part of a word": /-+\~_.
const WORD_CHAR = /[\p{L}\p{N}_/.\-+~\\]/u

/** 0 = whitespace/empty · 1 = word · 2 = other punctuation. Same-class
 *  runs select together: `foo` · `->` · a whitespace gap. */
function charClass(c: string): 0 | 1 | 2 {
  if (c === ' ' || c === '') return 0
  if (WORD_CHAR.test(c)) return 1
  return 2
}

/** Bounds of the same-class run at (col, row); null when out of bounds or
 *  on a noSelect cell. */
export function wordBoundsAt(
  screen: Screen,
  col: number,
  row: number,
): { lo: number; hi: number } | null {
  if (row < 0 || row >= screen.height) return null
  const width = screen.width
  const noSelect = screen.noSelect
  const rowOff = row * width

  // Tail click → head (the class check needs the actual grapheme).
  let c = col
  if (c > 0) {
    const cell = cellAt(screen, c, row)
    if (cell && cell.width === CellWidth.SpacerTail) c -= 1
  }
  if (c < 0 || c >= width || noSelect[rowOff + c] === 1) return null

  const startCell = cellAt(screen, c, row)
  if (!startCell) return null
  const cls = charClass(startCell.char)

  let lo = c
  while (lo > 0) {
    const prev = lo - 1
    if (noSelect[rowOff + prev] === 1) break
    const pc = cellAt(screen, prev, row)
    if (!pc) break
    if (pc.width === CellWidth.SpacerTail) {
      // Step over the spacer to the wide-char head.
      if (prev === 0 || noSelect[rowOff + prev - 1] === 1) break
      const head = cellAt(screen, prev - 1, row)
      if (!head || charClass(head.char) !== cls) break
      lo = prev - 1
      continue
    }
    if (charClass(pc.char) !== cls) break
    lo = prev
  }

  let hi = c
  while (hi < width - 1) {
    const next = hi + 1
    if (noSelect[rowOff + next] === 1) break
    const nc = cellAt(screen, next, row)
    if (!nc) break
    if (nc.width === CellWidth.SpacerTail) {
      // The tail belongs to the glyph at hi — include and continue past.
      hi = next
      continue
    }
    if (charClass(nc.char) !== cls) break
    hi = next
  }

  return { lo, hi }
}

/** Double-click: select the run; no-op out of bounds / on noSelect (state
 *  preserved). */
export function selectWordAt(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  const b = wordBoundsAt(screen, col, row)
  if (!b) return
  const lo = { col: b.lo, row }
  const hi = { col: b.hi, row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind: 'word' }
}

/** Triple-click: the whole row (extraction handles noSelect + trailing
 *  trim, so the copy is the visible line content). */
export function selectLineAt(s: SelectionState, screen: Screen, row: number): void {
  if (row < 0 || row >= screen.height) return
  const lo = { col: 0, row }
  const hi = { col: screen.width - 1, row }
  s.anchor = lo
  s.focus = hi
  s.isDragging = true
  s.anchorSpan = { lo, hi, kind: 'line' }
}

/** Drag-extend for word/line mode — THREE-WAY against the anchor span:
 *  mouse target entirely before ⇒ extend backward (anchor = span.hi);
 *  entirely after ⇒ forward (anchor = span.lo); overlapping ⇒ the span
 *  alone. Word mode falls back to the RAW cell on noSelect/out-of-bounds
 *  (dragging into gutters still extends; the row rides UNCLAMPED — bounds
 *  are the caller's job); line mode clamps the row. */
export function extendSelection(
  s: SelectionState,
  screen: Screen,
  col: number,
  row: number,
): void {
  if (!s.isDragging || !s.anchorSpan) return
  const span = s.anchorSpan
  let mLo: Point
  let mHi: Point
  if (span.kind === 'word') {
    const b = wordBoundsAt(screen, col, row)
    mLo = { col: b ? b.lo : col, row }
    mHi = { col: b ? b.hi : col, row }
  } else {
    const r = clamp(row, 0, screen.height - 1)
    mLo = { col: 0, row: r }
    mHi = { col: screen.width - 1, row: r }
  }
  if (comparePoints(mHi, span.lo) < 0) {
    s.anchor = span.hi
    s.focus = mLo
  } else if (comparePoints(mLo, span.hi) > 0) {
    s.anchor = span.lo
    s.focus = mHi
  } else {
    s.anchor = span.lo
    s.focus = span.hi
  }
}
