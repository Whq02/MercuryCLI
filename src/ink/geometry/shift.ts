// ============================================================================
//  shift.ts — T7: selection tracking under scroll.
//
//  Three movers, one per scroll source, all speaking the ledger's algebra
//  (prove-geometry-contract DEBT-ROUND-TRIP + CAPTURE-BOUNDARY):
//
//  • shiftSelection — keyboard scroll (PgUp/PgDn/ctrl+u/d/b/f): BOTH ends
//    track the content. Virtual rows carry the pre-clamp truth so reverse
//    scrolls restore true positions and POP the accumulators (without
//    them, clamp(5→0)+shift(+10)=10, not the true 5, and the copy
//    double-counts). Debt = each end's overshoot past its edge; a shrink
//    pops, and the invariant-restore truncates stale excess (checked
//    against NEW debt — capture runs BEFORE the shift in the production
//    flow, so at entry the accumulator is populated while old debt is
//    still 0: that is the normal establish path, not staleness). A
//    clamped endpoint's col resets to the full-width EDGE (edge-based,
//    not direction-based — virtual tracking means a top-clamped point can
//    stay top-clamped through a reverse shift): its original col was
//    consumed by the boundary capture, and keeping it would truncate the
//    NEW content at that screen row. Both ends past the SAME edge ⇒ clear
//    (otherwise a ghost 1-cell highlight lingers at the corner).
//
//  • shiftAnchor — drag-to-scroll: focus stays at the mouse; only the
//    anchor follows the text. Seeds the virtual row so the drag→follow
//    HANDOFF computes debt from TRUE rows (an already-clamped row would
//    under-count total drift and the next invariant-restore would
//    prematurely drop valid drag-phase captures).
//
//  • shiftSelectionForFollow — sticky/auto-follow while streaming: both
//    ends move; initialize-or-update virtual handling (the first clamp
//    can happen HERE with no prior keyboard scroll). Both ends strictly
//    past the TOP ⇒ clear and return true — the caller is inside onRender
//    and fires listeners DIRECTLY (notifySelectionChange would recurse).
//    Landing AT the edge survives: that cell holds correct text.
//    NEVER pops — only capture adds, only shiftSelection pops/truncates
//    (the moveFocus transient: a stale entry lingers until the next
//    keyboard shift reconciles).
//
//  • captureScrolledRows — the PAIR of every shift: selection∩range rows
//    extract under the clip band BEFORE the scroll overwrites them (a
//    scrolling drag must not smuggle rail columns into the copy through
//    the accumulators). After a boundary capture the anchor col AND BOTH
//    anchorSpan cols reset to the full-width edges — the col constraint
//    was consumed with the captured row, and after a blocked reversal the
//    drag can flip direction and read the OPPOSITE span side.
//
//  anchorSpan is never virtual-tracked (word/line drag-extend is
//  irrelevant to the keyboard round-trip) — plain clamp everywhere.
// ============================================================================
import type { Screen } from '../cell-grid.js'
import { clamp } from '../layout/geometry.js'
import { extractRowText } from './extract.js'
import { popForDebtShrink, pushCaptured, truncateToDebt } from './offscreen-ledger.js'
import {
  clearSelection,
  type Point,
  selectionBounds,
  type SelectionState,
} from './selection-model.js'

/** Plain clamp for the anchor span (no virtual tracking). */
function shiftSpan(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  edgeCols?: { min: number; max: number },
): void {
  if (!s.anchorSpan) return
  const shift = (p: Point): Point => {
    const r = p.row + dRow
    if (edgeCols) {
      if (r < minRow) return { col: edgeCols.min, row: minRow }
      if (r > maxRow) return { col: edgeCols.max, row: maxRow }
    }
    return { col: p.col, row: clamp(r, minRow, maxRow) }
  }
  s.anchorSpan = {
    lo: shift(s.anchorSpan.lo),
    hi: shift(s.anchorSpan.hi),
    kind: s.anchorSpan.kind,
  }
}

export function shiftSelection(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
  width: number,
): void {
  if (!s.anchor || !s.focus) return
  const vAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const vFocus = (s.virtualFocusRow ?? s.focus.row) + dRow
  if ((vAnchor < minRow && vFocus < minRow) || (vAnchor > maxRow && vFocus > maxRow)) {
    clearSelection(s)
    return
  }

  const oldMin = Math.min(s.virtualAnchorRow ?? s.anchor.row, s.virtualFocusRow ?? s.focus.row)
  const oldMax = Math.max(s.virtualAnchorRow ?? s.anchor.row, s.virtualFocusRow ?? s.focus.row)
  const oldAboveDebt = Math.max(0, minRow - oldMin)
  const oldBelowDebt = Math.max(0, oldMax - maxRow)
  const newAboveDebt = Math.max(0, minRow - Math.min(vAnchor, vFocus))
  const newBelowDebt = Math.max(0, Math.max(vAnchor, vFocus) - maxRow)

  popForDebtShrink(s, oldAboveDebt - newAboveDebt, 'above')
  popForDebtShrink(s, oldBelowDebt - newBelowDebt, 'below')
  truncateToDebt(s, newAboveDebt, 'above')
  truncateToDebt(s, newBelowDebt, 'below')

  const shift = (p: Point, vRow: number): Point => {
    if (vRow < minRow) return { col: 0, row: minRow }
    if (vRow > maxRow) return { col: width - 1, row: maxRow }
    return { col: p.col, row: vRow }
  }
  s.anchor = shift(s.anchor, vAnchor)
  s.focus = shift(s.focus, vFocus)
  s.virtualAnchorRow = vAnchor < minRow || vAnchor > maxRow ? vAnchor : undefined
  s.virtualFocusRow = vFocus < minRow || vFocus > maxRow ? vFocus : undefined
  shiftSpan(s, dRow, minRow, maxRow, { min: 0, max: width - 1 })
}

export function shiftAnchor(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): void {
  if (!s.anchor) return
  const raw = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  s.anchor = { col: s.anchor.col, row: clamp(raw, minRow, maxRow) }
  s.virtualAnchorRow = raw < minRow || raw > maxRow ? raw : undefined
  shiftSpan(s, dRow, minRow, maxRow)
}

export function shiftSelectionForFollow(
  s: SelectionState,
  dRow: number,
  minRow: number,
  maxRow: number,
): boolean {
  if (!s.anchor) return false
  const rawAnchor = (s.virtualAnchorRow ?? s.anchor.row) + dRow
  const rawFocus = s.focus ? (s.virtualFocusRow ?? s.focus.row) + dRow : undefined
  if (rawAnchor < minRow && rawFocus !== undefined && rawFocus < minRow) {
    clearSelection(s)
    return true
  }
  // Clamp from RAW, not p.row+dRow — a virtual position coming back
  // in-bounds lands at the TRUE row, not the stale clamped one.
  s.anchor = { col: s.anchor.col, row: clamp(rawAnchor, minRow, maxRow) }
  if (s.focus && rawFocus !== undefined) {
    s.focus = { col: s.focus.col, row: clamp(rawFocus, minRow, maxRow) }
  }
  s.virtualAnchorRow = rawAnchor < minRow || rawAnchor > maxRow ? rawAnchor : undefined
  s.virtualFocusRow =
    rawFocus !== undefined && (rawFocus < minRow || rawFocus > maxRow) ? rawFocus : undefined
  shiftSpan(s, dRow, minRow, maxRow)
  return false
}

export function captureScrolledRows(
  s: SelectionState,
  screen: Screen,
  firstRow: number,
  lastRow: number,
  side: 'above' | 'below',
): void {
  const b = selectionBounds(s)
  if (!b || firstRow > lastRow) return
  const { start, end } = b
  const lo = Math.max(firstRow, start.row)
  const hi = Math.min(lastRow, end.row)
  if (lo > hi) return

  const width = screen.width
  const sw = screen.softWrap
  const bandLo = s.clipLo ?? 0
  const bandHi = s.clipHi ?? width - 1
  const captured: string[] = []
  const capturedSW: boolean[] = []
  for (let row = lo; row <= hi; row++) {
    const colStart = Math.max(row === start.row ? start.col : 0, bandLo)
    const colEnd = Math.min(row === end.row ? end.col : width - 1, bandHi)
    captured.push(colEnd >= colStart ? extractRowText(screen, row, colStart, colEnd) : '')
    // A through-clip record (negative) is still a continuation of the
    // accumulator's previous entry — the captured predecessor.
    capturedSW.push(sw[row]! !== 0)
  }
  pushCaptured(s, captured, capturedSW, side)

  // Boundary col consumption: the captured boundary row already applied
  // the col constraint — reset anchor + BOTH span cols to the edges.
  const isBoundary =
    side === 'above'
      ? s.anchor && s.anchor.row === start.row && lo === start.row
      : s.anchor && s.anchor.row === end.row && hi === end.row
  if (isBoundary && s.anchor) {
    s.anchor = { col: side === 'above' ? 0 : width - 1, row: s.anchor.row }
    if (s.anchorSpan) {
      s.anchorSpan = {
        kind: s.anchorSpan.kind,
        lo: { col: 0, row: s.anchorSpan.lo.row },
        hi: { col: width - 1, row: s.anchorSpan.hi.row },
      }
    }
  }
}
