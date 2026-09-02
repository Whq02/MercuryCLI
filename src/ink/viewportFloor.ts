// ============================================================================
//  ink/viewportFloor.ts — the fullscreen surface's minimum size, and the one
//  line the product says when the window is under it.
//
//  Below the documented minimum no fullscreen surface can lay itself out
//  honestly: the cockpit sheds to strips, strips to an inline fallback, and
//  each step paints a frame nobody designed for. The alternate-screen host
//  reads ONE verdict here and paints ONE line instead — naming the minimum
//  and the way back (resize) — while the surface beneath stays mounted,
//  frozen at the last size that fit, so the way back repaints it whole with
//  every scroll position and draft intact.
//
//  The width floor is the cockpit's entry width (helmGeometry owns the
//  number) behind the cockpit's own exit hysteresis at the same boundary: a
//  drag that dips a few columns under the floor keeps the surface, and a
//  fresh window must reach the floor itself. The row floor is the shortest
//  window any designed fullscreen chrome paints in (the deck strip's floor
//  — the layout tier reads the same number); rows carry no band, like the
//  chrome's own row gate. One engage, one release.
// ============================================================================

import { HELM_HOME_MIN_COLS } from '../utils/helmGeometry.js'

/** The minimum width a fullscreen surface is painted at. */
export const VIEWPORT_FLOOR_COLS = HELM_HOME_MIN_COLS

/** The minimum height: below it the deck strip cannot coexist with the
 *  prompt, the status bar and an open suggestion menu, and no chrome
 *  designed for the alternate screen remains. */
export const VIEWPORT_FLOOR_ROWS = 22

/** The exit band under the width floor: a surface already painted at or
 *  above the floor survives a shrink to (floor − band); it goes under at
 *  the column below. The cockpit's chrome latch reads the SAME band, so the
 *  surface and its chrome agree on every column of a drag. */
export const VIEWPORT_FLOOR_EXIT_BAND = 3

export type ViewportFloorVerdict = { fits: true } | { fits: false; line: string }

/** The pure verdict. `surfaceUp` is the latch: whether the surface is
 *  currently painted (it fit on the previous frame). */
export function viewportFloorVerdict(columns: number, rows: number, surfaceUp: boolean): ViewportFloorVerdict {
  const colFloor = surfaceUp ? VIEWPORT_FLOOR_COLS - VIEWPORT_FLOOR_EXIT_BAND : VIEWPORT_FLOOR_COLS
  if (columns >= colFloor && rows >= VIEWPORT_FLOOR_ROWS) return { fits: true }
  return { fits: false, line: viewportFloorLine(columns, rows) }
}

/** The one line: the minimum, this window, the way. Shorter forms keep it
 *  on ONE row as the window narrows; the shortest still names the minimum
 *  and the way. */
export function viewportFloorLine(columns: number, rows: number): string {
  const forms = [
    `Mercury needs ${VIEWPORT_FLOOR_COLS} columns and ${VIEWPORT_FLOOR_ROWS} rows · this window is ${columns}×${rows} · resize the terminal to continue`,
    `needs ${VIEWPORT_FLOOR_COLS} columns × ${VIEWPORT_FLOOR_ROWS} rows · ${columns}×${rows} · resize to continue`,
    `needs ${VIEWPORT_FLOOR_COLS}×${VIEWPORT_FLOOR_ROWS} · resize`,
  ]
  // Two columns of padding either side keep the line off the frame's edge.
  const room = Math.max(0, columns - 2)
  return forms.find(f => f.length <= room) ?? forms[forms.length - 1]!
}
