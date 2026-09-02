// ============================================================================
//  offscreen-ledger.ts — T7: the off-screen text ledger.
//
//  During drag-to-scroll the screen buffer only holds the viewport — rows
//  leaving it mid-drag are captured into the accumulators so the copy
//  keeps the whole selection. The ledger owns the debt algebra the three
//  shift functions would otherwise reimplement in halves (the T7 dossier's one-
//  owner rule; prove-geometry-contract LAW DEBT-ROUND-TRIP is the net).
//
//  THE ORDERING DOCTRINE (the subtlest law in the family — a rewrite gets
//  this wrong unless it is stated):
//    • ABOVE accumulator: newest rows PUSH at the END (closest to the
//      on-screen content in reading order).
//    • BELOW accumulator: newest rows UNSHIFT at the FRONT (same reason,
//      mirrored).
//    • A debt-shrink POP therefore drops the NEWEST entries — the rows
//      returning on-screen (above: from the END; below: from the FRONT).
//    • The invariant-restore TRUNCATE keeps the NEWEST entries — the rows
//      closest to the screen (above: keep the END; below: keep the FRONT)
//      — dropping the OLDEST. Pop and truncate drop OPPOSITE ends, each
//      correct for its case.
//
//  The invariant: accumulator length ≤ debt. Excess entries are stale
//  (e.g. moveFocus voided the focus debt without trimming) and can never
//  be popped because their debt is already 0 — truncate reconciles.
//  Every mutation is CLAMPED (the old body's `length -= drop` could throw
//  RangeError when a capture under-covered the rows that left — here an
//  over-pop empties the accumulator instead).
// ============================================================================
import type { SelectionState } from './selection-model.js'

export type LedgerSide = 'above' | 'below'

/** Append captured rows on the given side, in capture order (top→bottom). */
export function pushCaptured(
  s: SelectionState,
  rows: string[],
  softWrapBits: boolean[],
  side: LedgerSide,
): void {
  if (side === 'above') {
    s.scrolledOffAbove.push(...rows)
    s.scrolledOffAboveSW.push(...softWrapBits)
  } else {
    s.scrolledOffBelow.unshift(...rows)
    s.scrolledOffBelowSW.unshift(...softWrapBits)
  }
}

/** Debt shrank by `drop` rows (a reverse scroll brought them back
 *  on-screen): drop the NEWEST entries. Clamped. */
export function popForDebtShrink(s: SelectionState, drop: number, side: LedgerSide): void {
  if (drop <= 0) return
  if (side === 'above') {
    const n = Math.min(drop, s.scrolledOffAbove.length)
    s.scrolledOffAbove.length -= n
    s.scrolledOffAboveSW.length = s.scrolledOffAbove.length
  } else {
    s.scrolledOffBelow.splice(0, drop)
    s.scrolledOffBelowSW.splice(0, drop)
  }
}

/** Restore the invariant (length ≤ debt), KEEPING the newest entries. */
export function truncateToDebt(s: SelectionState, debt: number, side: LedgerSide): void {
  if (side === 'above') {
    if (s.scrolledOffAbove.length > debt) {
      s.scrolledOffAbove = debt > 0 ? s.scrolledOffAbove.slice(-debt) : []
      s.scrolledOffAboveSW = debt > 0 ? s.scrolledOffAboveSW.slice(-debt) : []
    }
  } else {
    if (s.scrolledOffBelow.length > debt) {
      s.scrolledOffBelow = s.scrolledOffBelow.slice(0, debt)
      s.scrolledOffBelowSW = s.scrolledOffBelowSW.slice(0, debt)
    }
  }
}
