// ============================================================================
//  services/concourse/coordinatorOverflow — the overflow ladder on the
//  coordinator's chair. The coordinator's turn road is not the main query
//  loop (a durable conversation store replayed per turn), so the turn
//  machine's ladder cannot ride it; the honest shared layer is the CONTRACT:
//  the same typed OverflowSignal (the runtime's stamp), one fold of the
//  same conversation through the landed summarize-in-place owner, one
//  retry of the same turn, and a typed refusal that names what was tried.
//  The live call throws the typed error below when a round settled ONLY as
//  an overflow refusal; the lane's governed turn catches it and walks the
//  ladder; the A4 catch rows the exhaustion as a visible refusal receipt.
// ============================================================================
import type { OverflowSignal } from '../api/overflowSignal.js'
import { overflowWhoClause } from '../compact/overflowRecovery.js'

/** A coordinator round refused by the provider for not fitting the window. */
export class CoordinatorOverflowError extends Error {
  readonly overflow: OverflowSignal
  constructor(overflow: OverflowSignal, message: string) {
    super(message)
    this.name = 'CoordinatorOverflowError'
    this.overflow = overflow
  }
}

/** The typed read every catch performs — null for any other failure. */
export function coordinatorOverflowOf(err: unknown): OverflowSignal | null {
  return err instanceof CoordinatorOverflowError ? err.overflow : null
}

export type CoordinatorOverflowWhy = 'retry-overflowed' | 'auto-compact-off' | 'fold-refused' | 'nothing-to-fold'

/** The refusal the pane rows (the A4 catch prefixes "coordinator turn
 *  failed — "): the numbers, what was tried, the chair's own remedies. */
export function coordinatorOverflowRefusal(signal: OverflowSignal, why: CoordinatorOverflowWhy, detail?: string): string {
  const head = `context overflowed (${overflowWhoClause(signal)})`
  const remedy = '/clear starts fresh, or pick a model with a larger window (the rail chip)'
  switch (why) {
    case 'retry-overflowed':
      return `${head} — the conversation was folded and the turn retried once, and it still overflows; ${remedy}`
    case 'auto-compact-off':
      return `${head} — automatic compaction is off, so the emergency fold did not run; /compact folds the conversation by hand, ${remedy}`
    case 'fold-refused':
      return `${head} — the fold was refused${detail !== undefined && detail !== '' ? ` (${detail})` : ''}; ${remedy}`
    case 'nothing-to-fold':
      return `${head} — the conversation is already at its kept tail, nothing older to fold; ${remedy}`
  }
}
