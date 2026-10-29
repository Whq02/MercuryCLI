
import { logForDebugging } from '../../utils/debug.js'
import {
  emptyAttentionState,
  foldAttention,
  type AttentionFact,
  type AttentionState,
} from './contracts.js'
import {
  emptyRelationState,
  foldRelations,
  type RelationFact,
  type RelationState,
} from './relations.js'

export interface AttentionStoreSnapshot {
  attention: AttentionState
  relations: RelationState
}

export type AttentionGatherer = () => {
  attention?: readonly AttentionFact[]
  relations?: readonly RelationFact[]
}

interface GathererEntry {
  gather: AttentionGatherer
  subscribe?: (cb: () => void) => () => void
  activeUnsub?: (() => void) | null
}

const gatherers = new Set<GathererEntry>()

export function registerAttentionGatherer(
  g: AttentionGatherer,
  opts?: { subscribe?: (cb: () => void) => () => void },
): () => void {
  const entry: GathererEntry = { gather: g, subscribe: opts?.subscribe, activeUnsub: null }
  gatherers.add(entry)
  if (armed) {
    entry.activeUnsub = entry.subscribe?.(() => recompute()) ?? null
    recompute()
  }
  return () => {
    entry.activeUnsub?.()
    entry.activeUnsub = null
    gatherers.delete(entry)
  }
}


let attention: AttentionState = emptyAttentionState()
let relations: RelationState = emptyRelationState()
let snapshot: AttentionStoreSnapshot = { attention, relations }

let armed = false
const listeners = new Set<() => void>()

function recompute(): void {
  let nextAttention = attention
  let nextRelations = relations
  for (const entry of gatherers) {
    try {
      const out = entry.gather()
      if (out.attention?.length) nextAttention = foldAttention(nextAttention, out.attention)
      if (out.relations?.length) nextRelations = foldRelations(nextRelations, out.relations)
    } catch (e) {
      logForDebugging(`[attention] gatherer threw (skipped): ${e}`)
    }
  }
  if (nextAttention === attention && nextRelations === relations) return
  attention = nextAttention
  relations = nextRelations
  snapshot = { attention, relations }
  for (const l of [...listeners]) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[attention] listener threw (ignored): ${e}`)
    }
  }
}

function arm(): void {
  if (armed) return
  armed = true
  for (const entry of gatherers) {
    entry.activeUnsub = entry.subscribe?.(() => recompute()) ?? null
  }
  recompute()
}

function disarm(): void {
  armed = false
  for (const entry of gatherers) {
    entry.activeUnsub?.()
    entry.activeUnsub = null
  }
}

export function subscribeAttentionStore(cb: () => void): () => void {
  listeners.add(cb)
  arm()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) disarm()
  }
}

export function cachedAttentionStore(): AttentionStoreSnapshot {
  return snapshot
}

export function isAttentionStoreArmed(): boolean {
  return armed
}

export function _attentionStoreStateForTesting(): {
  listeners: number
  armed: boolean
  gatherers: number
} {
  return { listeners: listeners.size, armed, gatherers: gatherers.size }
}

export function resetAttentionStoreForTesting(): void {
  disarm()
  listeners.clear()
  gatherers.clear()
  attention = emptyAttentionState()
  relations = emptyRelationState()
  snapshot = { attention, relations }
}
