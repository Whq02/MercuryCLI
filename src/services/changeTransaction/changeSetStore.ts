// ============================================================================
//  changeTransaction/changeSetStore — owner-scoped change-set plans
// Bounded conversation-lifetime state, the structure/store
//  idiom: a ring of immutable plans per owner, an `evicted` set so
//  expired-from-the-ring ≠ never-existed (the honesty floor), and TTL expiry
//  checked at read time. Byte payloads (originals/planned) ride the
//  ChangeSetPlanned result in-memory only and are NEVER stored here — a
//  plan_id apply re-derives bytes and revalidates against CURRENT disk.
// ============================================================================

import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import {
  CHANGESET_BOUNDS,
  type ChangeSetPlan,
  type ChangeSetPlanState,
} from './changeSetContracts.js'

interface OwnerPlans {
  plans: Map<string, ChangeSetPlan>
  order: string[]
  /** Ids the bounded ring dropped (expired ≠ absent). */
  evicted: Set<string>
}

const store = new OwnerScopedStore<OwnerPlans>({
  name: 'changeset-plans',
  create: () => ({ plans: new Map(), order: [], evicted: new Set() }),
  cap: 32,
})
registerOwnerScopedStore(store)

export function rememberChangeSetPlan(owner: OwnerKey, plan: ChangeSetPlan): void {
  const owned = store.get(owner)
  if (!owned.plans.has(plan.id)) owned.order.push(plan.id)
  owned.plans.set(plan.id, plan)
  while (owned.order.length > CHANGESET_BOUNDS.planRing) {
    const dropped = owned.order.shift()!
    owned.plans.delete(dropped)
    owned.evicted.add(dropped)
    if (owned.evicted.size > 128) {
      const first = owned.evicted.values().next().value
      if (first !== undefined) owned.evicted.delete(first)
    }
  }
}

export function getChangeSetPlan(owner: OwnerKey, id: string): ChangeSetPlan | undefined {
  return store.peek(owner)?.plans.get(id)
}

/** evicted ≠ absent: true when the ring dropped this id. */
export function changeSetPlanEvicted(owner: OwnerKey, id: string): boolean {
  return store.peek(owner)?.evicted.has(id) ?? false
}

/** TTL check against the plan's own expiry metadata. */
export function changeSetPlanExpired(plan: ChangeSetPlan, now: number = Date.now()): boolean {
  return now > plan.expiresAt
}

export function setChangeSetPlanState(
  owner: OwnerKey,
  id: string,
  state: ChangeSetPlanState,
  patch: Partial<ChangeSetPlan> = {},
): ChangeSetPlan | undefined {
  const owned = store.peek(owner)
  const cur = owned?.plans.get(id)
  if (!owned || !cur) return undefined
  const next = { ...cur, ...patch, state }
  owned.plans.set(id, next)
  return next
}

/** TEST-ONLY: reset (proof harnesses). */
export function _resetChangeSetStoreForTesting(): void {
  store.clearAllForShutdown()
}
