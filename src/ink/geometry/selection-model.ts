// ============================================================================
//  selection-model.ts — T7: the selection state record
//  and its lifecycle.
//
//  A linear, screen-buffer-coordinate selection (terminal-native, not
//  rectangular): ANCHOR (mouse-down) + FOCUS (current drag position),
//  normalized to reading order on read. The record is a FLAT mutable
//  object — App.tsx pokes lastPressHadAlt and reads isDragging/anchor
//  directly (the excluded render tree), so the field contract is public
//  and stays put (prove-geometry-contract LIFECYCLE pins the reset
//  matrix).
//
//  Five state families live here (the operations own their algebra in
//  sibling modules):
//    geometry (anchor/focus/isDragging) · mode span (anchorSpan — the
//    multi-click word/line span drag-extend grows from) · clip band
//    (clipLo/clipHi — pane-scoped columns; overlay AND extraction obey
//    the same band: what you see highlighted IS what you copy) ·
//    off-screen accumulators (scrolledOffAbove/Below + soft-wrap bits —
//    owned by offscreen-ledger.ts) · clamp debt (virtualAnchorRow/
//    virtualFocusRow — pre-clamp truth so reverse scrolls restore
//    positions and pop accumulators).
// ============================================================================

export type Point = { col: number; row: number }

export type SelectionState = {
  /** Where the mouse-down occurred. Null when no selection. */
  anchor: Point | null
  /** Column CLIP BAND (inclusive), captured at drag-start from the pane
   *  under the anchor (task #80: a drag over the transcript must not copy
   *  the side rails — terminal selection is screen-linear, so a multi-row
   *  drag in a 3-pane layout otherwise sweeps every column). undefined ⇒
   *  no clip (anchor outside any scroll pane, or the pane spans the full
   *  width). */
  clipLo?: number
  clipHi?: number
  /** Current drag position (updated on mouse-move while dragging). */
  focus: Point | null
  /** True between mouse-down and mouse-up. */
  isDragging: boolean
  /** Word/line mode: the initial multi-click span drag-extend grows from,
   *  so the original word/line stays selected even when dragging backward
   *  past it. Null ⇔ char mode. */
  anchorSpan: { lo: Point; hi: Point; kind: 'word' | 'line' } | null
  /** Text from rows that scrolled out ABOVE the viewport during
   *  drag-to-scroll — newest pushed at the END (closest to on-screen in
   *  reading order). Prepended by getSelectedText. */
  scrolledOffAbove: string[]
  /** Rows scrolled out BELOW when dragging up — newest unshifted at the
   *  FRONT (closest to on-screen). Appended by getSelectedText. */
  scrolledOffBelow: string[]
  /** Soft-wrap bits parallel to scrolledOffAbove — true means the row is
   *  a continuation of the one before it (the newline was word-wrap, not
   *  source). Captured at scroll time — the screen's softWrap plane
   *  shifts with content. */
  scrolledOffAboveSW: boolean[]
  /** Parallel to scrolledOffBelow. */
  scrolledOffBelowSW: boolean[]
  /** Pre-clamp anchor row: set when a shift clamps the anchor so a
   *  reverse scroll restores the true position AND pops the accumulator
   *  (highlight ≡ copy). Undefined ⇔ no clamp debt. */
  virtualAnchorRow?: number
  /** Same for focus. */
  virtualFocusRow?: number
  /** The mouse-down carried the alt modifier (SGR bit 0x08) — on macOS
   *  xterm.js this signals macOptionClickForcesSelection is OFF (the
   *  footer hint plumbing). */
  lastPressHadAlt: boolean
}

export function createSelectionState(): SelectionState {
  return {
    anchor: null,
    focus: null,
    isDragging: false,
    anchorSpan: null,
    scrolledOffAbove: [],
    scrolledOffBelow: [],
    scrolledOffAboveSW: [],
    scrolledOffBelowSW: [],
    lastPressHadAlt: false,
  }
}

/** Mouse-down: every family resets. Focus stays null until the first real
 *  drag motion — a click-release with no drag must never highlight a cell
 *  (hasSelection/selectionBounds gate on focus). */
export function startSelection(s: SelectionState, col: number, row: number): void {
  s.anchor = { col, row }
  s.clipLo = undefined
  s.clipHi = undefined
  s.focus = null
  s.isDragging = true
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

/** Drag motion. The anchor-cell tremor guard: mode-1002 terminals can fire
 *  a drag event AT the anchor cell (sub-pixel tremor / motion-release
 *  pair) — setting focus there would turn a bare click into a 1-cell
 *  selection and clobber the clipboard via copy-on-select. Once focus
 *  exists (a real drag), tracking is normal INCLUDING back to the anchor
 *  (a deliberate 1-cell selection). */
export function updateSelection(s: SelectionState, col: number, row: number): void {
  if (!s.isDragging) return
  if (!s.focus && s.anchor && s.anchor.col === col && s.anchor.row === row) return
  s.focus = { col, row }
}

/** Mouse-up: the highlight stays (copyable) until clearSelection. */
export function finishSelection(s: SelectionState): void {
  s.isDragging = false
}

export function clearSelection(s: SelectionState): void {
  s.anchor = null
  s.focus = null
  s.isDragging = false
  s.anchorSpan = null
  s.scrolledOffAbove = []
  s.scrolledOffBelow = []
  s.scrolledOffAboveSW = []
  s.scrolledOffBelowSW = []
  s.virtualAnchorRow = undefined
  s.virtualFocusRow = undefined
  s.lastPressHadAlt = false
}

/** Semantic keyboard focus moves (bounds/wrap applied by the caller). */
export type FocusMove = 'left' | 'right' | 'up' | 'down' | 'lineStart' | 'lineEnd'

/** Keyboard focus repositioning (shift+arrow): anchor stays; drops to char
 *  mode (native macOS: shift+arrow after a word-select extends
 *  char-by-char). Voids ONLY the focus clamp debt — explicit repositioning
 *  no longer reflects the pre-clamp intent; the anchor's own round-trip
 *  debt stays valid, and the accumulators are kept (the next shift's
 *  invariant-restore reconciles them). */
export function moveFocus(s: SelectionState, col: number, row: number): void {
  if (!s.focus) return
  s.anchorSpan = null
  s.focus = { col, row }
  s.virtualFocusRow = undefined
}

/** -1 if a < b, 1 if a > b, 0 if equal (reading order: row then col). */
export function comparePoints(a: Point, b: Point): number {
  if (a.row !== b.row) return a.row < b.row ? -1 : 1
  if (a.col !== b.col) return a.col < b.col ? -1 : 1
  return 0
}

export function hasSelection(s: SelectionState): boolean {
  return s.anchor !== null && s.focus !== null
}

/** Normalized bounds (start ≤ end in reading order); null when inactive. */
export function selectionBounds(s: SelectionState): { start: Point; end: Point } | null {
  if (!s.anchor || !s.focus) return null
  return comparePoints(s.anchor, s.focus) <= 0
    ? { start: s.anchor, end: s.focus }
    : { start: s.focus, end: s.anchor }
}

/** Set the column clip band (inclusive) from the scroll pane under the
 *  drag anchor. A full-width band stores as undefined so unclipped paths
 *  stay byte-identical; lo clamps at 0 and hi floors at lo. */
export function setSelectionClipBand(
  s: SelectionState,
  lo: number,
  hi: number,
  screenWidth: number,
): void {
  if (lo <= 0 && hi >= screenWidth - 1) {
    s.clipLo = undefined
    s.clipHi = undefined
    return
  }
  s.clipLo = Math.max(0, lo)
  s.clipHi = Math.max(s.clipLo, hi)
}
