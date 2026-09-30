import type { OverflowSignal } from '../api/overflowSignal.js'
import { overflowWhoClause } from '../compact/overflowRecovery.js'

export class CoordinatorOverflowError extends Error {
  readonly overflow: OverflowSignal
  constructor(overflow: OverflowSignal, message: string) {
    super(message)
    this.name = 'CoordinatorOverflowError'
    this.overflow = overflow
  }
}

export function coordinatorOverflowOf(err: unknown): OverflowSignal | null {
  return err instanceof CoordinatorOverflowError ? err.overflow : null
}

export type CoordinatorOverflowWhy = 'retry-overflowed' | 'compaction-off' | 'fold-refused' | 'nothing-to-fold'

export function coordinatorOverflowRefusal(signal: OverflowSignal, why: CoordinatorOverflowWhy, detail?: string): string {
  const head = `context overflowed (${overflowWhoClause(signal)})`
  const remedy = '/clear starts fresh, or pick a model with a larger window (the rail chip)'
  switch (why) {
    case 'retry-overflowed':
      return `${head} — the conversation was folded and the turn retried once, and it still overflows; ${remedy}`
    case 'compaction-off':
      return `${head} — compaction is disabled (MERCURY_COMPACT=0), so nothing could fold; ${remedy}`
    case 'fold-refused':
      return `${head} — the fold was refused${detail !== undefined && detail !== '' ? ` (${detail})` : ''}; ${remedy}`
    case 'nothing-to-fold':
      return `${head} — the conversation is already at its kept tail, nothing older to fold; ${remedy}`
  }
}
