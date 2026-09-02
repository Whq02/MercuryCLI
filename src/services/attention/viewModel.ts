/**
 * attentionView — the ONE attention view-model, the
 * federationView idiom one concern over: surfaces (the MercuryFrame
 * needs-you chip, the A2 Workbench attention board, the graph view) read
 * THIS composed snapshot instead of assembling their own subset of the
 * attention store.
 *
 * Laws (inherited from federationView, proven in
 * scripts/attention/prove-attention-store.ts):
 *   - STABLE REFERENCE: cachedAttentionView() returns the SAME object until
 *     a source actually changed (useSyncExternalStore-safe; references to
 *     the store's own state objects, never field-copied rebuilds).
 *   - UI-ONLY COALESCING: burst-kind statusFeed notifications ride ONE
 *     bounded trailing window (the feed's BURST_WINDOW_MS); store
 *     changes and immediate kinds flush now. Folds are upstream and never
 *     coalesced — this module gates renders only.
 *   - SOLO DORMANCY: no subscriber ⇒ no statusFeed relay, no store
 *     subscription, no timer.
 */

import { subscribeRoomStatusFeed } from './statusFeed.js'
import { logForDebugging } from '../../utils/debug.js'
import { BURST_WINDOW_MS } from './statusFeed.js'
import type { AttentionState } from './contracts.js'
import { bucketItems } from './contracts.js'
import type { RelationState } from './relations.js'
import {
  cachedAttentionStore,
  subscribeAttentionStore,
} from './store.js'

export interface AttentionViewV1 {
  v: 1
  /** Bumps once per minted snapshot (stable-reference no-ops don't bump). */
  version: number
  atMs: number
  /** The attention fold state, BY REFERENCE. */
  attention: AttentionState
  /** The relation fold state, BY REFERENCE. */
  relations: RelationState
  /** Operator-blocking count — the needs-you bucket's size. */
  needsYou: number
}

const listeners = new Set<() => void>()
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let feedUnsub: (() => void) | null = null
let storeUnsub: (() => void) | null = null

/** Presence/decision/control kinds repaint now; burst kinds ride the window
 *  (the federationView classification, reused verbatim). */
function isImmediateKind(kind: string | null): boolean {
  if (kind === null) return true
  if (kind === 'link') return true
  if (kind === 'presence.join' || kind === 'presence.leave') return true
  if (kind === 'work.decision') return true
  if (kind === 'sys.room') return true
  return false
}

function flushNotifications(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!dirty) return
  dirty = false
  for (const l of [...listeners]) {
    try {
      l()
    } catch (e) {
      logForDebugging(`[attention-view] listener threw (ignored): ${e}`)
    }
  }
}

function schedule(kind: string | null): void {
  dirty = true
  if (listeners.size === 0) return // dormant: no timer without a consumer
  if (isImmediateKind(kind)) {
    flushNotifications()
    return
  }
  if (timer) return
  timer = setTimeout(flushNotifications, BURST_WINDOW_MS)
  timer.unref?.()
}

/** Subscribe to coalesced view changes. First subscriber arms the store
 *  subscription + the ONE statusFeed relay; the last tears down. */
export function subscribeAttentionView(cb: () => void): () => void {
  listeners.add(cb)
  if (!storeUnsub) {
    // Store changes are the view's own facts — immediate class.
    storeUnsub = subscribeAttentionStore(() => schedule(null))
  }
  if (!feedUnsub) {
    feedUnsub = subscribeRoomStatusFeed(kind => schedule(kind ?? null))
  }
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) teardownAttentionView()
  }
}

function teardownAttentionView(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  feedUnsub?.()
  feedUnsub = null
  storeUnsub?.()
  storeUnsub = null
}

let last: AttentionViewV1 | null = null
let lastAttention: AttentionState | null = null
let lastRelations: RelationState | null = null
let version = 0

/**
 * RENDER-PATH read: reference-stable across no-ops — the store's own state
 * references ARE the change signature (its fold returns the same objects on
 * a no-op), so parity with the sources is by construction.
 */
export function cachedAttentionView(): AttentionViewV1 {
  const { attention, relations } = cachedAttentionStore()
  if (last && attention === lastAttention && relations === lastRelations) return last
  lastAttention = attention
  lastRelations = relations
  last = {
    v: 1,
    version: ++version,
    atMs: Date.now(),
    attention,
    relations,
    needsYou: bucketItems(attention, 'needs-you').length,
  }
  return last
}

/** Test seams (never product-read). */
export function _attentionViewStateForTesting(): {
  listeners: number
  timerArmed: boolean
} {
  return { listeners: listeners.size, timerArmed: timer !== null }
}

export function resetAttentionViewForTesting(): void {
  teardownAttentionView()
  listeners.clear()
  last = null
  lastAttention = null
  lastRelations = null
  version = 0
  dirty = false
}
