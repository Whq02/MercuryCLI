
import { clampRowToWidth } from './ansiText.js'
import type { OverlayInput, TailInput, Viewport } from './contracts.js'

export interface ComposedTail {
  rows: readonly string[]
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

  let rows: string[] = parts
  if (overlay && !overlay.fullscreen) {
    const height = Math.max(overlay.rows.length, parts.length)
    rows = []
    for (let i = 0; i < height; i++) {
      rows.push(overlay.rows[i] ?? parts[i] ?? '')
    }
  }

  const bound = Math.max(1, viewport.rows - 1)
  let dropped = 0
  if (rows.length > bound) {
    dropped = rows.length - bound
    rows = rows.slice(dropped)
  }

  const clamped = rows.map(r => clampRowToWidth(r, viewport.cols))

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
