
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
  capsule: { version: 1; state: 'installed' | 'degraded' | 'none'; reason: string }
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

export function recordAppliedPlan(owner: OwnerKey, digest: string): void {
  const s = epochs.get(owner)
  s.lastAppliedPlanDigest = digest
  s.lastAppliedPlanAt = Date.now()
}

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

export function markContextDegraded(owner: OwnerKey, reason: string): void {
  const s = epochs.get(owner)
  s.degraded.push(reason)
  if (s.degraded.length > 8) s.degraded.shift()
}

export function ifEpochCurrent(owner: OwnerKey, capturedEpoch: number, fn: () => void): boolean {
  if (epochs.get(owner).epoch !== capturedEpoch) return false
  fn()
  return true
}
