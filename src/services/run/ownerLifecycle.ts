// ============================================================================
//  ownerLifecycle — ONE disposal registry for owner-scoped state (of
//  the Sol 5.6 frontier sprint).
//
//  Two registration planes:
//    · STORES — every OwnerScopedStore registers once at module init
//      (registerOwnerScopedStore); disposeOwner(owner) then tears the owner
//      out of every store without the stores knowing about each other.
//    · AD-HOC DISPOSERS — per-owner resources that aren't a store entry
//      (a debug adapter child, a watcher) register (owner, id, fn);
//      idempotent per (owner, id).
//
//  Callers: the REPL on /clear and session switch, QueryEngine/headless
//  teardown, resume reactivation, and process exit. Ordinary turn completion
//  is NOT owner disposal. All disposal is idempotent and error-isolated.
// ============================================================================

import { registerCleanup } from '../../utils/cleanupRegistry.js'
import type { OwnerKey } from './ownerKey.js'

type StoreLike = {
  name: string
  dispose(owner: OwnerKey): void
  /** Present on stores whose disposer drains durable work. */
  disposeAsync?(owner: OwnerKey): Promise<void>
  /** Barrier over drains started without a caller to await them. */
  drainPending?(): Promise<void>
  clearAllForShutdown(): void
  readonly size: number
}

const stores: StoreLike[] = []
const adhoc = new Map<OwnerKey, Map<string, () => void | Promise<void>>>()

/** Register an owner-scoped store (module-init time; duplicates by name are
 *  replaced so hot-reload/proof re-imports never double-register). */
export function registerOwnerScopedStore(store: StoreLike): void {
  const at = stores.findIndex(s => s.name === store.name)
  if (at >= 0) stores.splice(at, 1)
  stores.push(store)
}

/** Register an ad-hoc per-owner disposer. Idempotent per (owner, id). */
export function registerOwnerDisposer(
  owner: OwnerKey,
  id: string,
  dispose: () => void | Promise<void>,
): void {
  let byId = adhoc.get(owner)
  if (!byId) {
    byId = new Map()
    adhoc.set(owner, byId)
  }
  byId.set(id, dispose)
}

/** Remove a previously-registered ad-hoc disposer WITHOUT running it
 *  (the resource was already released by its normal path). */
export function unregisterOwnerDisposer(owner: OwnerKey, id: string): void {
  const byId = adhoc.get(owner)
  if (!byId) return
  byId.delete(id)
  if (byId.size === 0) adhoc.delete(owner)
}

/**
 * Tear an owner out of every registry. Idempotent; each disposer failure is
 * isolated. Ad-hoc disposers run first (they may still read store state),
 * then every registered store drops the owner.
 */
export async function disposeOwner(owner: OwnerKey): Promise<void> {
  const byId = adhoc.get(owner)
  adhoc.delete(owner)
  if (byId) {
    for (const [, dispose] of byId) {
      try {
        await dispose()
      } catch {
        /* isolated */
      }
    }
  }
  // TWO PASSES, and the split is load-bearing. Every store drops the owner
  // SYNCHRONOUSLY first, then their drains are awaited together.
  //
  // Awaiting each store in turn looks equivalent and is not: the first `await`
  // suspends the loop, so stores after it keep their state until a later
  // microtask. Callers that do not await this function — `void
  // disposeOwner(...)` on session switch, /clear, and several proofs — have
  // always been able to rely on the owner's state being gone the moment the
  // call returns, and a one-line-at-a-time loop silently took that away.
  const draining: Array<Promise<void>> = []
  for (const store of stores) {
    try {
      // disposeAsync removes the owner and starts its disposer synchronously;
      // only the DRAIN is deferred. A store that drains durable work must be
      // awaited, because teardown returning while a required write is still in
      // flight is the loss closes.
      if (store.disposeAsync) draining.push(store.disposeAsync(owner))
      else store.dispose(owner)
    } catch {
      /* isolated */
    }
  }
  await Promise.all(draining.map(p => p.catch(() => undefined)))
}

/** Process-exit / test-harness sweep across every owner in every registry. */
export async function disposeAllOwnersForShutdown(): Promise<void> {
  for (const owner of [...adhoc.keys()]) await disposeOwner(owner)
  for (const store of stores) {
    try {
      store.clearAllForShutdown()
    } catch {
      /* isolated */
    }
  }
  // Settle the drains the sweep started, so shutdown is a settlement rather
  // than a set of abandoned promises.
  for (const store of stores) {
    try {
      await store.drainPending?.()
    } catch {
      /* isolated */
    }
  }
}

/** Diagnostics/proof: live counts per registry + ad-hoc disposer count. */
export function ownerLifecycleCounts(): { stores: Record<string, number>; adhoc: number } {
  const byStore: Record<string, number> = {}
  for (const store of stores) byStore[store.name] = store.size
  let adhocCount = 0
  for (const [, byId] of adhoc) adhocCount += byId.size
  return { stores: byStore, adhoc: adhocCount }
}

/**
 * Register the process-exit sweep with the cleanup registry gracefulShutdown
 * awaits. At MODULE INIT, deliberately: the first attempt put this inside
 * wireOwnerLifecycle(), which is only reachable through a dynamic import on
 * the resume/continue paths — so a plain `mercury` launch or a headless `-p`
 * run never registered it, and a generation sitting in the coalesce window was
 * still abandoned at exit. This module is imported by runCoordinator, which
 * every turn reaches, so the registration follows the run kernel itself.
 * Idempotent: the registry is a Set and this module initialises once.
 */
registerCleanup(() => disposeAllOwnersForShutdown())
