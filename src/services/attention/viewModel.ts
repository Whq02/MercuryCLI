
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
  version: number
  atMs: number
  attention: AttentionState
  relations: RelationState
  needsYou: number
}

const listeners = new Set<() => void>()
let dirty = false
let timer: ReturnType<typeof setTimeout> | null = null
let feedUnsub: (() => void) | null = null
let storeUnsub: (() => void) | null = null

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
  if (listeners.size === 0) return
  if (isImmediateKind(kind)) {
    flushNotifications()
    return
  }
  if (timer) return
  timer = setTimeout(flushNotifications, BURST_WINDOW_MS)
  timer.unref?.()
}

export function subscribeAttentionView(cb: () => void): () => void {
  listeners.add(cb)
  if (!storeUnsub) {
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
