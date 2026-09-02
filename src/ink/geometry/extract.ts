// ============================================================================
//  extract.ts — T7: selection → text.
//
//  Copy truth (prove-geometry-contract COPY-TRUTH differential + F4-4):
//  rows join with newlines UNLESS the screen's softWrap plane marks a row
//  as a word-wrap continuation — those concatenate onto the previous row
//  so the copy matches the logical source line, not the visual layout.
//  noSelect cells (gutters, sigils) and wide-glyph spacer cells skip; the
//  clip band bounds every row; the trailing trim applies only to the LAST
//  fragment of each logical line (a continuation-feeding row keeps its
//  separator space — the wrap put it at contentEnd-1).
//
//  THE SOFT-WRAP ENCODING (shared contract with compose-buffer.writeOp):
//  softWrap[row] == 0 ⇒ row starts a logical line. POSITIVE v ⇒ row
//  continues row-1, whose content ends at column v-1 (extraction clamps
//  row-1 to v-1 and skips its trim so the join survives). NEGATIVE v ⇒ a
//  THROUGH-CLIP continuation: the true predecessor was clipped above the
//  scroll viewport and was NEVER PAINTED — row-1 on screen is unrelated
//  static content (the T7 contractor's header-join artifact: the old
//  positive-only encoding concatenated the first visible wrap row onto
//  the header above the scrollbox, and padded the header via the
//  misattributed contentEnd). A negative record joins ONLY onto the
//  accumulator flow (the captured true predecessor); on-screen neighbors
//  neither join nor clamp against it.
// ============================================================================
import type { Screen } from '../cell-grid.js'
import { CellWidth, cellAt } from '../cell-grid.js'
import { selectionBounds, type SelectionState } from './selection-model.js'

/** Extract one screen row within [colStart, colEnd]. When the next row is
 *  a TRUE (positive) continuation, clamp to its recorded content end and
 *  keep the separator space; a negative (through-clip) record on the next
 *  row describes a predecessor that is NOT this row — no clamp, normal
 *  trim. */
export function extractRowText(
  screen: Screen,
  row: number,
  colStart: number,
  colEnd: number,
): string {
  const noSelect = screen.noSelect
  const rowOff = row * screen.width
  const contentEnd = row + 1 < screen.height ? screen.softWrap[row + 1]! : 0
  const lastCol = contentEnd > 0 ? Math.min(colEnd, contentEnd - 1) : colEnd
  let line = ''
  for (let col = colStart; col <= lastCol; col++) {
    if (noSelect[rowOff + col] === 1) continue
    const cell = cellAt(screen, col, row)
    if (!cell) continue
    if (cell.width === CellWidth.SpacerTail || cell.width === CellWidth.SpacerHead) {
      continue
    }
    line += cell.char
  }
  return contentEnd > 0 ? line : line.replace(/\s+$/, '')
}

/** Merge a row into the logical-line list: sw=true concatenates onto the
 *  previous line; otherwise a new line starts. */
export function joinRows(lines: string[], text: string, sw: boolean | undefined): void {
  if (sw && lines.length > 0) {
    lines[lines.length - 1] += text
  } else {
    lines.push(text)
  }
}

/** The full selection: above-accumulator rows, the clipped on-screen
 *  range, below-accumulator rows — soft-wrap joins throughout. */
export function getSelectedText(s: SelectionState, screen: Screen): string {
  const b = selectionBounds(s)
  if (!b) return ''
  const { start, end } = b
  const sw = screen.softWrap
  const lines: string[] = []

  for (let i = 0; i < s.scrolledOffAbove.length; i++) {
    joinRows(lines, s.scrolledOffAbove[i]!, s.scrolledOffAboveSW[i])
  }

  const lo = s.clipLo ?? 0
  const hi = s.clipHi ?? screen.width - 1
  for (let row = start.row; row <= end.row; row++) {
    const rowStart = Math.max(row === start.row ? start.col : 0, lo)
    const rowEnd = Math.min(row === end.row ? end.col : screen.width - 1, hi)
    if (rowEnd < rowStart) continue
    const swVal = sw[row]!
    // Positive: row-1 is the true predecessor — join. Negative
    // (through-clip): the predecessor never painted; join ONLY when this
    // is the range's first row and the accumulator carries the captured
    // predecessor — an on-screen neighbor above is unrelated content.
    const joins = swVal > 0 || (swVal < 0 && row === start.row && lines.length > 0)
    joinRows(lines, extractRowText(screen, row, rowStart, rowEnd), joins)
  }

  for (let i = 0; i < s.scrolledOffBelow.length; i++) {
    joinRows(lines, s.scrolledOffBelow[i]!, s.scrolledOffBelowSW[i])
  }

  return lines.join('\n')
}
