// ============================================================================
//  render-engine/inlinePainter.ts — the inline paint strategy (laws E2, E3).
//
//  The painter turns (settled lines to append, previous tail block, next
//  tail block) into ONE frame body — a single string the door delivers as a
//  whole unit. Its discipline:
//
//  · SETTLED LINES ARE WRITTEN ONCE. An appended line's bytes leave here
//    exactly once and are never revisited — no rewrite, no rediff, no audit.
//  · ERASE BEFORE SCROLL. Stale live rows are erased (EL) before any write
//    that can scroll, so only settled rows and blanks ever move up into
//    history (E3).
//  · DAMAGE ONLY. Without an append, the tail block is diffed row-wise; an
//    unchanged row costs zero bytes.
//  · CLOSED VOCABULARY. The body uses CR, LF, cursor up/down, CHA, EL, SGR
//    reset and cursor hide/show — nothing else: no ED variants, no scroll
//    regions, no mode churn (E4's closed set; the replay oracle understands
//    every byte).
//  · LF-ONLY ROW CREATION. New rows come from LF at the last existing row —
//    creating on a part-filled screen, scrolling at the bottom — never from
//    cursor-down into rows that may not exist.
//
//  The cursor model is relative: the painter knows the park position within
//  its own block and moves with CR + CUU/CUD + CHA. A CR precedes every row
//  move, which also cancels a pending-wrap state after a full-width write.
// ============================================================================

import { HIDE_CURSOR, SHOW_CURSOR } from '../ink/termio/dec.js'
import { cursorDown, cursorTo, cursorUp, eraseToEndOfLine } from '../ink/termio/csi.js'

const EL = eraseToEndOfLine()
const SGR_RESET = '\x1b[0m'

export interface PaintResult {
  body: string
  settledLinesWritten: number
  tailRowsWritten: number
}

export class InlineTailPainter {
  /** The tail block as last painted; row 0 is the block top. */
  private prev: string[] = ['']
  private parkRow = 0
  private parkCol = 0

  /** The painted block's height (probe port). */
  blockHeight(): number {
    return this.prev.length
  }

  /** Forget the painted block (width epoch break): the next paint repaints
   *  the whole tail fresh. Settled history above the block stays exactly as
   *  the terminal holds it. */
  forget(): void {
    this.prev = ['']
    this.parkRow = 0
    this.parkCol = 0
  }

  /**
   * Compose one frame body. `settled` lines append ABOVE the live tail —
   * written once, then owned by history. `next` replaces the live block.
   * `park` is the cursor's rest position within the new block.
   */
  paint(
    settled: readonly string[],
    next: readonly string[],
    park: { row: number; col: number },
    options: { forceRepaint?: boolean } = {},
  ): PaintResult {
    const prev = this.prev
    let body = ''
    let row = this.parkRow // current row in PREV-block coordinates
    let col = this.parkCol
    let settledWrites = 0
    let tailWrites = 0

    const cr = (): void => {
      if (col !== 0) {
        body += '\r'
        col = 0
      }
    }
    const moveToRow = (target: number): void => {
      if (target === row) return
      cr() // row moves ride CR first — cancels pending-wrap, fixes the column
      body += target < row ? cursorUp(row - target) : cursorDown(target - row)
      row = target
    }

    if (settled.length > 0) {
      // APPEND. Walk to the block top, then write each settled line over a
      // stale live row (erased first) with LF creation between lines.
      moveToRow(0)
      cr()
      for (let i = 0; i < settled.length; i++) {
        body += EL + settled[i] + SGR_RESET + '\r\n'
        settledWrites++
        row++
        col = 0
      }
      // The live block now begins at `row`. Write it whole (every row is
      // either stale or fresh after an append).
      if (next.length === 0) {
        // No live rows: the row under the cursor may hold stale content —
        // erase it; it is the block's one blank row now.
        body += EL
      }
      for (let j = 0; j < next.length; j++) {
        body += EL + next[j]
        col = Number.MAX_SAFE_INTEGER // conservatively non-zero; CR fixes it
        tailWrites++
        if (j < next.length - 1) {
          body += '\r\n'
          row++
          col = 0
        }
      }
      // Stale rows beyond the new block: erase to blanks. Cursor-down only —
      // these rows exist (the old block occupied them); at the true screen
      // bottom a clamped cursor-down means there is nothing below to erase.
      const consumed = settled.length + Math.max(next.length, 1)
      const staleBeyond = prev.length - consumed
      for (let k = 0; k < staleBeyond; k++) {
        cr()
        body += cursorDown(1)
        row++
        body += EL
      }
    } else {
      // DAMAGE-ONLY DIFF of the live block.
      const force = options.forceRepaint === true
      const shared = Math.min(prev.length, next.length)
      for (let r = 0; r < shared; r++) {
        if (!force && prev[r] === next[r]) continue
        moveToRow(r)
        cr()
        body += EL + next[r]
        col = Number.MAX_SAFE_INTEGER
        tailWrites++
      }
      if (next.length > prev.length) {
        // Growth: LF creation from the last existing row.
        moveToRow(prev.length - 1)
        cr()
        for (let r = prev.length; r < next.length; r++) {
          body += '\r\n' + EL + next[r]
          row++
          col = Number.MAX_SAFE_INTEGER
          tailWrites++
        }
      } else if (next.length < prev.length) {
        // Shrink: erase the orphaned rows to blanks.
        for (let r = next.length; r < prev.length; r++) {
          moveToRow(r)
          cr()
          body += EL
        }
      }
    }

    // Park. Row indices are in the NEW block's coordinates: its top sits at
    // (settled.length) in prev-coordinates during an append walk, and the
    // walk above tracked `row` in the same space throughout.
    const blockTop = settled.length > 0 ? settled.length : 0
    const parkAbs = blockTop + Math.min(park.row, Math.max(0, next.length - 1))
    moveToRow(parkAbs)
    cr()
    if (park.col > 0) {
      body += cursorTo(park.col + 1)
      col = park.col
    }

    this.prev = next.slice()
    if (this.prev.length === 0) this.prev = ['']
    this.parkRow = Math.min(parkAbs - blockTop, this.prev.length - 1)
    this.parkCol = col === Number.MAX_SAFE_INTEGER ? 0 : col

    if (body === '') return { body: '', settledLinesWritten: 0, tailRowsWritten: 0 }
    return {
      body: HIDE_CURSOR + body + SGR_RESET + SHOW_CURSOR,
      settledLinesWritten: settledWrites,
      tailRowsWritten: tailWrites,
    }
  }
}
