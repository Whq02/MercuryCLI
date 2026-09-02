// ============================================================================
//  overlay-pass.ts — T6: the overlay pass as one owner.
//
//  Two responsibilities that would otherwise be ~95 mutating lines inside onRender,
//  both alt-screen-only in effect:
//
//  1. FOLLOW-SCROLL SELECTION TRANSLATION — when the compose walk scrolled a
//     ScrollBox under a live selection, translate the selection so the SAME
//     text stays highlighted. captureScrolledRows and shift* are a PAIR:
//     capture grabs the rows about to scroll off, shift moves the endpoint
//     so the same viewport rows won't re-intersect next frame — capture
//     without shift makes scrolledOffAbove grow without bound and
//     getSelectedText returns ever-growing text on each re-copy. The guards
//     are load-bearing: the ANCHOR must sit on scrollbox content (a footer/
//     prompt selection sits on static text the scroll doesn't move —
//     shifting would clamp it to viewportBottom and teleport it INTO the
//     scrollbox), and outside a drag BOTH ends must sit inside (a drag from
//     the scrollbox released over the footer leaves focus outside; a
//     straddling selection gets NEITHER shift NOR capture — the footer
//     endpoint pins it, text scrolls under the highlight, and copy reads
//     the current screen: no accumulation). The dragging branch shifts only
//     the anchor (focus tracks the mouse, screen-local), so it needs no
//     both-ends check. An auto-clear (both ends overshot minRow) fires the
//     caller's listeners DIRECTLY — notifySelectionChange() would recurse
//     into onRender; the listeners schedule a React update for LATER.
//
//  2. OVERLAYS — selection inversion, scan-highlight (inverse on ALL
//     visible matches, less/vim style), and the position-based CURRENT
//     highlight (yellow at positions[currentIdx] + rowOffset — positions
//     were scanned once at message mount; navigation is index arithmetic).
//     Overlays write via setCellStyleId which does NOT track damage — the
//     caller's damage policy (full damage while active, contamination on
//     the cleanup frame) covers them; the returned flags feed it.
// ============================================================================
import type { Screen, StylePool } from '../cell-grid.js'
import type { FollowScroll } from '../compose-walk.js'
import { applyPositionedHighlight, type MatchPosition } from '../render-to-screen.js'
import { applySearchHighlight } from '../searchHighlight.js'
import {
  applySelectionOverlay,
  captureScrolledRows,
  hasSelection,
  type SelectionState,
  shiftAnchor,
  shiftSelectionForFollow,
} from '../geometry/selection.js'

export type SearchPositions = {
  positions: MatchPosition[]
  rowOffset: number
  /** The scanned element's absolute screen-left — positions are
   *  element-relative in BOTH axes (FN-016 R6). */
  colOffset: number
  currentIdx: number
}

export type OverlayPassInput = {
  altScreen: boolean
  /** signals.consumeFollowScroll() — one-shot, already consumed. */
  follow: FollowScroll | null
  /** The live selection state — translated IN PLACE. */
  selection: SelectionState
  /** The displayed frame's screen (frontFrame) — the capture source for
   *  rows about to scroll off. */
  captureScreen: Screen
  /** The composed frame's screen — the overlay paint target. */
  screen: Screen
  stylePool: StylePool
  searchQuery: string
  searchPositions: SearchPositions | null
  /** Fired when the follow translation auto-cleared the selection. */
  onSelectionCleared: () => void
}

export type OverlayPassResult = { selActive: boolean; hlActive: boolean }

export function applyOverlayPass(input: OverlayPassInput): OverlayPassResult {
  const { follow, selection } = input

  if (
    follow &&
    selection.anchor &&
    selection.anchor.row >= follow.viewportTop &&
    selection.anchor.row <= follow.viewportBottom
  ) {
    const { delta, viewportTop, viewportBottom } = follow
    if (selection.isDragging) {
      if (hasSelection(selection)) {
        captureScrolledRows(selection, input.captureScreen, viewportTop, viewportTop + delta - 1, 'above')
      }
      shiftAnchor(selection, -delta, viewportTop, viewportBottom)
    } else if (
      !selection.focus ||
      (selection.focus.row >= viewportTop && selection.focus.row <= viewportBottom)
    ) {
      if (hasSelection(selection)) {
        captureScrolledRows(selection, input.captureScreen, viewportTop, viewportTop + delta - 1, 'above')
      }
      const cleared = shiftSelectionForFollow(selection, -delta, viewportTop, viewportBottom)
      if (cleared) input.onSelectionCleared()
    }
  }

  let selActive = false
  let hlActive = false
  if (input.altScreen) {
    selActive = hasSelection(selection)
    if (selActive) {
      applySelectionOverlay(input.screen, selection, input.stylePool)
    }
    hlActive = applySearchHighlight(input.screen, input.searchQuery, input.stylePool)
    if (input.searchPositions) {
      const sp = input.searchPositions
      const posApplied = applyPositionedHighlight(input.screen, input.stylePool, sp.positions, sp.rowOffset, sp.colOffset, sp.currentIdx)
      hlActive = hlActive || posApplied
    }
  }
  return { selActive, hlActive }
}
