// ============================================================================
//  structure/store — owner-scoped query/preview records.
//  Bounded conversation-lifetime state: query results feed previews;
//  previews carry the stale-refusal truth (per-file digests) and, once
//  applied, the observed refs. Durable mutation truth stays with the
//  receipt ring / transaction plane — this store is the structural
//  domain's working memory, resource-visible via mercury://structure/*.
// ============================================================================

import { registerOwnerScopedStore } from '../run/ownerLifecycle.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { OwnerScopedStore } from '../run/ownerScopedStore.js'
import { subscribeChangeReceipts } from '../changeTransaction/receipts.js'
import type { StructurePreview, StructureQueryResult, PreviewState } from './contracts.js'

const QUERY_RING = 16
const PREVIEW_RING = 16

interface OwnerStructure {
  queries: Map<string, StructureQueryResult>
  queryOrder: string[]
  previews: Map<string, StructurePreview>
  previewOrder: string[]
  /** Ids the bounded rings dropped (expired ≠ absent, the honesty floor). */
  evicted: Set<string>
}

const store = new OwnerScopedStore<OwnerStructure>({
  name: 'structure-plane',
  create: () => ({
    queries: new Map(),
    queryOrder: [],
    previews: new Map(),
    previewOrder: [],
    evicted: new Set(),
  }),
  cap: 32,
})
registerOwnerScopedStore(store)

function ring<T>(map: Map<string, T>, order: string[], evicted: Set<string>, cap: number): void {
  while (order.length > cap) {
    const dropped = order.shift()!
    map.delete(dropped)
    evicted.add(dropped)
    if (evicted.size > 128) {
      const first = evicted.values().next().value
      if (first !== undefined) evicted.delete(first)
    }
  }
}

export function rememberQuery(owner: OwnerKey, result: StructureQueryResult): void {
  const owned = store.get(owner)
  if (!owned.queries.has(result.id)) owned.queryOrder.push(result.id)
  owned.queries.set(result.id, result)
  ring(owned.queries, owned.queryOrder, owned.evicted, QUERY_RING)
}

export function getQuery(owner: OwnerKey, id: string): StructureQueryResult | undefined {
  return store.peek(owner)?.queries.get(id)
}

export function rememberPreview(owner: OwnerKey, preview: StructurePreview): void {
  const owned = store.get(owner)
  if (!owned.previews.has(preview.id)) owned.previewOrder.push(preview.id)
  owned.previews.set(preview.id, preview)
  ring(owned.previews, owned.previewOrder, owned.evicted, PREVIEW_RING)
}

export function getPreview(owner: OwnerKey, id: string): StructurePreview | undefined {
  return store.peek(owner)?.previews.get(id)
}

export function setPreviewState(
  owner: OwnerKey,
  id: string,
  state: PreviewState,
  patch: Partial<StructurePreview> = {},
): StructurePreview | undefined {
  const owned = store.peek(owner)
  const cur = owned?.previews.get(id)
  if (!owned || !cur) return undefined
  const next = { ...cur, ...patch, state }
  owned.previews.set(id, next)
  return next
}

export function listQueries(owner: OwnerKey): StructureQueryResult[] {
  const owned = store.peek(owner)
  if (!owned) return []
  return owned.queryOrder.map(id => owned.queries.get(id)!).filter(Boolean)
}

export function listPreviews(owner: OwnerKey): StructurePreview[] {
  const owned = store.peek(owner)
  if (!owned) return []
  return owned.previewOrder.map(id => owned.previews.get(id)!).filter(Boolean)
}

/** expired ≠ absent: true when the ring dropped this id. */
export function structureIdExpired(owner: OwnerKey, id: string): boolean {
  return store.peek(owner)?.evicted.has(id) ?? false
}

// ── receipt back-reference ──────────────────────────────────────────────────
// The apply's mutation settles through the EXACTLY-ONCE receipt seam (the
// tool returns a ToolEffect; the effectObserver mints the receipt; the
// transaction plane ingests it). We subscribe to attach the canonical
// transaction/receipt refs BACK onto the applied preview record so
// mercury://structure/preview/<id> shows the full chain — no second
// transaction record is ever created here.
let installed = false
export function installStructureReceiptBackref(): void {
  if (installed) return
  installed = true
  subscribeChangeReceipts(receipt => {
    try {
      if (receipt.effect.operation !== 'structure.apply') return
      const previewId = (receipt.effect.details as { previewId?: string } | undefined)?.previewId
      if (!previewId) return
      const owned = store.peek(receipt.owner)
      const preview = owned?.previews.get(previewId)
      if (!owned || !preview) return
      owned.previews.set(previewId, {
        ...preview,
        receiptRef: `mercury://receipt/${receipt.id}`,
        transactionRef: `mercury://transaction/txn-${receipt.id}`,
      })
    } catch {
      /* back-reference never breaks the receipt seam */
    }
  })
}
installStructureReceiptBackref()

/** TEST-ONLY: reset (proof harnesses). */
export function _resetStructureStoreForTesting(): void {
  store.clearAllForShutdown()
}
