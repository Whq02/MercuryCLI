import type { SelectionState } from './selection-model.js'

export type LedgerSide = 'above' | 'below'

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
