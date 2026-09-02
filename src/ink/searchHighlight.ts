// Post-compose inverse-highlight of every visible occurrence of a query,
// applied to the composed screen before the diff. Case-insensitive, with a
// NON-OVERLAPPING advance (the pager/editor convention — advancing by one
// double-inverts overlapping matches, which renders as unhighlighted text).

import {
  cellAt,
  CellWidth,
  setCellStyleId,
  type Screen,
  type StylePool,
} from './cell-grid.js'

type RowText = {
  text: string
  /** Screen column of each contributing cell, by contribution index. */
  cellColumns: number[]
  /** For every code unit of the lowercased text, which contribution it came
   *  from — lowercasing can change code-unit length and wide characters
   *  occupy two cells, so unit→cell must be mapped explicitly. */
  unitToContribution: number[]
}

/** The three cell-skip conditions, shared verbatim with the selection and
 *  position-scan paths: wide-character tails, wrapped-wide padding, and
 *  non-selectable cells (gutters are not search targets). */
function skipCell(screen: Screen, x: number, y: number, width: CellWidth): boolean {
  if (width === CellWidth.SpacerTail) return true
  if (width === CellWidth.SpacerHead) return true
  return screen.noSelect[y * screen.width + x] !== 0
}

export function buildRowText(screen: Screen, y: number): RowText {
  const cellColumns: number[] = []
  const unitToContribution: number[] = []
  let text = ''
  for (let x = 0; x < screen.width; x++) {
    const cell = cellAt(screen, x, y)
    if (!cell) continue
    if (skipCell(screen, x, y, cell.width)) continue
    const char = cell.char
    if (char === '') continue
    // Lowercase per cell, NOT on the joined string, or the index map
    // desynchronises from the search positions.
    const lowered = char.toLowerCase()
    const contribution = cellColumns.length
    cellColumns.push(x)
    for (let i = 0; i < lowered.length; i++) {
      unitToContribution.push(contribution)
    }
    text += lowered
  }
  return { text, cellColumns, unitToContribution }
}

/** Returns whether any match was highlighted, so the caller can force
 *  full-frame damage. */
export function applySearchHighlight(
  screen: Screen,
  query: string,
  stylePool: StylePool,
): boolean {
  if (!query) return false
  const needle = query.toLowerCase()
  let applied = false
  for (let y = 0; y < screen.height; y++) {
    const row = buildRowText(screen, y)
    if (row.text.length < needle.length) continue
    let from = 0
    for (;;) {
      const index = row.text.indexOf(needle, from)
      if (index === -1) break
      // Non-overlapping: advance by the query length, not by one.
      from = index + needle.length
      const firstContribution = row.unitToContribution[index]
      const lastContribution = row.unitToContribution[index + needle.length - 1]
      if (firstContribution === undefined || lastContribution === undefined) {
        continue
      }
      const firstColumn = row.cellColumns[firstContribution]!
      const lastColumn = row.cellColumns[lastContribution]!
      for (let x = firstColumn; x <= lastColumn; x++) {
        const cell = cellAt(screen, x, y)
        if (!cell) continue
        setCellStyleId(screen, x, y, stylePool.withInverse(cell.styleId))
      }
      applied = true
    }
  }
  return applied
}
