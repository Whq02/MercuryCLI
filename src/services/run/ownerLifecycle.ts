
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import type { OwnerKey } from './ownerKey.js'

type StoreLike = {
  name: string
  dispose(owner: OwnerKey): void
  disposeAsync?(owner: OwnerKey): Promise<void>
  drainPending?(): Promise<void>
  clearAllForShutdown(): void
  readonly size: number
}

const stores: StoreLike[] = []
const adhoc = new Map<OwnerKey, Map<string, () => void | Promise<void>>>()

export function registerOwnerScopedStore(store: StoreLike): void {
  const at = stores.findIndex(s => s.name === store.name)
  if (at >= 0) stores.splice(at, 1)
  stores.push(store)
}

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

export function unregisterOwnerDisposer(owner: OwnerKey, id: string): void {
  const byId = adhoc.get(owner)
  if (!byId) return
  byId.delete(id)
  if (byId.size === 0) adhoc.delete(owner)
}

export async function disposeOwner(owner: OwnerKey): Promise<void> {
  const byId = adhoc.get(owner)
  adhoc.delete(owner)
  if (byId) {
    for (const [, dispose] of byId) {
      try {
        await dispose()
      } catch {
      }
    }
  }
  const draining: Array<Promise<void>> = []
  for (const store of stores) {
    try {
      if (store.disposeAsync) draining.push(store.disposeAsync(owner))
      else store.dispose(owner)
    } catch {
    }
  }
  await Promise.all(draining.map(p => p.catch(() => undefined)))
}

export async function disposeAllOwnersForShutdown(): Promise<void> {
  for (const owner of [...adhoc.keys()]) await disposeOwner(owner)
  for (const store of stores) {
    try {
      store.clearAllForShutdown()
    } catch {
    }
  }
  for (const store of stores) {
    try {
      await store.drainPending?.()
    } catch {
    }
  }
}

export function ownerLifecycleCounts(): { stores: Record<string, number>; adhoc: number } {
  const byStore: Record<string, number> = {}
  for (const store of stores) byStore[store.name] = store.size
  let adhocCount = 0
  for (const [, byId] of adhoc) adhocCount += byId.size
  return { stores: byStore, adhoc: adhocCount }
}

registerCleanup(() => disposeAllOwnersForShutdown())
