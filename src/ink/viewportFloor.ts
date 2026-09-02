// ============================================================================
//  ink/viewportFloor.ts — the fullscreen surface's minimum size, and the one
//  line the product says when the window is under it.
//
//  Below the minimum no fullscreen surface can lay itself out honestly: the
//  plain world's strips shed into an inline fallback, borders clip, and each
//  step paints a frame nobody designed. The hosts read ONE verdict here: the
//  alternate-screen host paints ONE line instead — naming the minimum and
//  the way back (resize) — and every host under the floor keeps its surface
//  mounted, out of layout, frozen at the last size that fit, so the way back
//  repaints it whole with every scroll position and draft intact.
//
//  The width floor is the plain world's own minimum (80 columns — the width
//  the deck-strip home, the boot faces and the Concourse's board pane are
//  designed down to); the cockpit's entry width (helmGeometry's 100) is a
//  chrome tier above it, never the floor. The floor stands behind the same
//  exit hysteresis the cockpit's chrome latch uses at its own boundary: a
//  drag that dips a few columns under the floor keeps the surface, and a
//  fresh window must reach the floor itself. The row floor is the shortest
//  window any designed fullscreen chrome paints in (the deck strip's floor —
//  the layout tier reads the same number); rows carry no band, like the
//  chrome's own row gate. ONE latch, module-owned like the chrome's, so the
//  alternate-screen host and a route surface host painting over it read the
//  same answer for the same frame. One engage, one release.
// ============================================================================

/** The minimum width a fullscreen surface is painted at. */
export const VIEWPORT_FLOOR_COLS = 80

/** The minimum height: below it the deck strip cannot coexist with the
 *  prompt, the status bar and an open suggestion menu, and no chrome
 *  designed for the alternate screen remains. */
export const VIEWPORT_FLOOR_ROWS = 22

/** The exit band under the width floor: a surface already painted at or
 *  above the floor survives a shrink to (floor − band); it goes under at
 *  the column below. The cockpit's chrome latch reads the SAME band at its
 *  own boundary, so a drag settles the same way at both. */
export const VIEWPORT_FLOOR_EXIT_BAND = 3

export type ViewportFloorVerdict = { fits: true } | { fits: false; line: string }

/** The pure verdict. `surfaceUp` is the latch: whether the surface is
 *  currently painted (it fit on the previous frame). */
export function viewportFloorVerdict(columns: number, rows: number, surfaceUp: boolean): ViewportFloorVerdict {
  const colFloor = surfaceUp ? VIEWPORT_FLOOR_COLS - VIEWPORT_FLOOR_EXIT_BAND : VIEWPORT_FLOOR_COLS
  if (columns >= colFloor && rows >= VIEWPORT_FLOOR_ROWS) return { fits: true }
  return { fits: false, line: viewportFloorLine(columns, rows) }
}

/** The ONE latch: whether the fullscreen world is painted right now. */
let surfaceUp = false

/** The LIVE verdict every host reads — the pure verdict behind the one
 *  latch. Idempotent within a frame: the first reading settles the latch
 *  and every later reading of the same size answers the same. */
export function viewportFloorLive(columns: number, rows: number): ViewportFloorVerdict {
  const verdict = viewportFloorVerdict(columns, rows, surfaceUp)
  surfaceUp = verdict.fits
  return verdict
}

/** Test/proof seam: put the latch back to its boot state. */
export function resetViewportFloorForTests(): void {
  surfaceUp = false
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
