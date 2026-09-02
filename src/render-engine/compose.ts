// ============================================================================
//  render-engine/compose.ts — the live-tail frame model (laws E3, E8, E11).
//
//  Below retained history the engine repaints a BOUNDED region only: the
//  streaming turn's unsettled tail, the running-tool surface, the composer,
//  and the status strip. Composition here is a pure function of those parts
//  plus at most one compositing overlay; its cost is a function of the LIVE
//  TAIL alone — settled rows are frozen bytes and never pass through this
//  code again (E11).
//
//  A non-fullscreen overlay COMPOSITES over the tail block row-for-row and
//  never touches settled history (E8); fullscreen surfaces borrow the
//  alternate screen at the engine level instead and never reach this
//  composer.
// ============================================================================

import { clampRowToWidth } from './ansiText.js'
import type { OverlayInput, TailInput, Viewport } from './contracts.js'

export interface ComposedTail {
  /** The tail block's rows, each clamped to the viewport width; the block
   *  height never exceeds viewport rows − 1 (E3's bound). */
  rows: readonly string[]
  /** Park target: row index within the block + 0-based column. */
  park: { row: number; col: number }
}

export function composeTailBlock(
  tail: TailInput,
  overlay: OverlayInput | null,
  viewport: Viewport,
): ComposedTail {
  const parts: string[] = []
  const composerStart =
    tail.streamRows.length + tail.toolRows.length
  parts.push(...tail.streamRows, ...tail.toolRows, ...tail.composerRows, ...tail.statusRows)

  // Composite a (non-fullscreen) overlay over the block, row-for-row from
  // the top. The overlay never grows the block past its own rows + the tail
  // beneath it, and it never reaches settled history above the block.
  let rows: string[] = parts
  if (overlay && !overlay.fullscreen) {
    const height = Math.max(overlay.rows.length, parts.length)
    rows = []
    for (let i = 0; i < height; i++) {
      rows.push(overlay.rows[i] ?? parts[i] ?? '')
    }
  }

  // E3: the region never exceeds the viewport (one row of headroom keeps at
  // least one settled row in view). Overflow truncates from the top — the
  // oldest unsettled rows leave the live view first and return as settled
  // history when the turn settles.
  const bound = Math.max(1, viewport.rows - 1)
  let dropped = 0
  if (rows.length > bound) {
    dropped = rows.length - bound
    rows = rows.slice(dropped)
  }

  const clamped = rows.map(r => clampRowToWidth(r, viewport.cols))

  // Park at the composer's declared cursor, adjusted for the drop; a block
  // without a declared cursor parks at the last row's start.
  let parkRow = clamped.length - 1
  let parkCol = 0
  if (tail.cursor && !overlay) {
    parkRow = Math.min(
      Math.max(0, composerStart + tail.cursor.rowOffset - dropped),
      clamped.length - 1,
    )
    parkCol = Math.max(0, Math.min(tail.cursor.col, viewport.cols - 1))
  }
  return { rows: clamped, park: { row: parkRow, col: parkCol } }
}
