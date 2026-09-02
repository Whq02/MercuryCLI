// One host's reading of the viewport floor: the live verdict (the floor's
// one latch) and the size its surface is laid out at — the live size while
// the window fits, the last size that fit while it does not. A host under
// the floor keeps its surface mounted but out of layout (display none: the
// layout engine zeroes the subtree, so no measurement effect ever reads a
// too-small geometry) and provides the frozen size to it, so the way back
// to that size changes nothing about the surface — no rescale of a
// transcript's height cache, no remount — and the settled repaint shows
// every scroll position and draft where it was. `active` false is a host
// that never yields (a nested pane inside a surface that already fits).

import { useRef } from 'react'
import type { TerminalSize } from '../components/TerminalSizeContext.js'
import { VIEWPORT_FLOOR_COLS, VIEWPORT_FLOOR_ROWS, viewportFloorLive } from '../viewportFloor.js'

export type ViewportFloorState = {
  fits: boolean
  /** The one line to paint under the floor; null while the window fits. */
  line: string | null
  /** The size the surface lays out at (frozen under the floor). */
  surfaceSize: TerminalSize | null
}

export function useViewportFloor(size: TerminalSize | null, active: boolean): ViewportFloorState {
  const lastFitRef = useRef<TerminalSize | null>(null)
  const verdict = !active || size === null ? ({ fits: true } as const) : viewportFloorLive(size.columns, size.rows)
  if (verdict.fits && size !== null) lastFitRef.current = size
  if (!verdict.fits && lastFitRef.current === null && size !== null) {
    // Never fit yet (a window born under the floor): lay the surface out
    // at the floor itself until a size that fits arrives.
    lastFitRef.current = { columns: VIEWPORT_FLOOR_COLS, rows: Math.max(size.rows, VIEWPORT_FLOOR_ROWS) }
  }
  return {
    fits: verdict.fits,
    line: verdict.fits ? null : verdict.line,
    surfaceSize: verdict.fits ? size : lastFitRef.current,
  }
}
