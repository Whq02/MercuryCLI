// ============================================================================
//  contextEpochs — owner-scoped context lifecycle state (Sol 5.6 frontier
//  sprint).
//
//  Each conversation owner carries ONE context-state record: a monotonically
//  increasing EPOCH (advanced by /clear, auto/manual compaction, and resume),
//  the last applied request-plan digest, the last transition's kind/reason/
//  token deltas, and explicit degraded flags. Cleanup that captured an older
//  epoch must not touch state from a newer one — the guard every late sweep
//  checks. No inference from usage percentages: transitions are EXPLICIT.
// ============================================================================

import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'
import { getRunSnapshot, noteRunEvent } from './runCoordinator.js'

export type ContextTransitionKind =
  | 'auto-compact'
  | 'manual-compact'
  | 'micro-compact'
  | 'clear'
  | 'resume'

export interface ContextTransition {
  kind: ContextTransitionKind
  reason: string
  at: number
  tokensBefore: number | null
  tokensAfter: number | null
  preservedTailCount: number | null
}

export interface ContextEpochState {
  epoch: number
  lastAppliedPlanDigest: string | null
  lastAppliedPlanAt: number | null
  lastTransition: ContextTransition | null
  /** The continuation capsule installed by the last compaction. */
  capsule: { version: 1; state: 'installed' | 'degraded' | 'none'; reason: string }
  /** Facts the record could not determine exactly (never guessed). */
  degraded: string[]
}

const epochs = new OwnerScopedStore<ContextEpochState>({
  name: 'context-epochs',
  create: () => ({
    epoch: 0,
    lastAppliedPlanDigest: null,
    lastAppliedPlanAt: null,
    lastTransition: null,
    capsule: { version: 1, state: 'none', reason: 'no compaction yet' },
    degraded: [],
  }),
})
registerOwnerScopedStore(epochs)

export function getContextEpoch(owner: OwnerKey): ContextEpochState {
  return epochs.get(owner)
}

/** Record the digest of the plan actually SENT (apply mode only). */
export function recordAppliedPlan(owner: OwnerKey, digest: string): void {
  const s = epochs.get(owner)
  s.lastAppliedPlanDigest = digest
  s.lastAppliedPlanAt = Date.now()
}

/**
 * Advance the owner's context epoch for an EXPLICIT transition. Returns the
 * new epoch. Folds a context-epoch event into the owner's run (when live).
 */
export function advanceContextEpoch(
  owner: OwnerKey,
  transition: Omit<ContextTransition, 'at'> & {
    capsule?: { state: 'installed' | 'degraded' | 'none'; reason: string }
  },
): number {
  const s = epochs.get(owner)
  s.epoch++
  s.lastTransition = {
    kind: transition.kind,
    reason: transition.reason,
    at: Date.now(),
    tokensBefore: transition.tokensBefore,
    tokensAfter: transition.tokensAfter,
    preservedTailCount: transition.preservedTailCount,
  }
  if (transition.capsule) {
    s.capsule = { version: 1, ...transition.capsule }
    if (transition.capsule.state === 'degraded') {
      s.degraded.push(`epoch ${s.epoch}: ${transition.capsule.reason}`)
      if (s.degraded.length > 8) s.degraded.shift()
    }
  }
  if (getRunSnapshot(owner)) {
    noteRunEvent(owner, {
      type: 'context-epoch',
      at: Date.now(),
      epoch: s.epoch,
      kind: transition.kind,
      reason: transition.reason,
    })
  }
  return s.epoch
}

/** Mark a fact the epoch record could not determine exactly. */
export function markContextDegraded(owner: OwnerKey, reason: string): void {
  const s = epochs.get(owner)
  s.degraded.push(reason)
  if (s.degraded.length > 8) s.degraded.shift()
}

/** Epoch guard for late async sweeps: run `fn` only if the epoch the caller
 *  captured is STILL current (a newer epoch means newer state owns the
 *  resources — the stale sweep must drop its work). */
export function ifEpochCurrent(owner: OwnerKey, capturedEpoch: number, fn: () => void): boolean {
  if (epochs.get(owner).epoch !== capturedEpoch) return false
  fn()
  return true
}
