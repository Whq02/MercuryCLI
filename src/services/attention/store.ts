/**
 * The ONE incremental attention store — owner gatherers → AttentionFacts →
 * the pure fold (contracts.ts), plus the relation fold, composed behind a
 * stable-reference snapshot.
 *
 * ARCHITECTURE (the collaboration-store idiom, adapted):
 *   - NO room-frame fold of its own: every gatherer reads an OWNER's cached
 *     projection or typed event channel. Room-scoped owners (tickets, collab)
 *     already seed via the snapshot path — attention inherits snapshot
 *     compatibility THROUGH them; there is no second replay.
 *   - GATHERER REGISTRY: owner families above caduceus (run manifests,
 *     workbench review queue, roster) register fact gatherers from their own
 *     layer via registerAttentionGatherer — the dependency arrow stays
 *     downward. The queue gatherer lives here (input-core is below caduceus;
 *     collaboration/correlation.ts set the precedent).
 *   - SOLO DORMANCY: no subscriber ⇒ no queue subscription, no consumption
 *     tap, no state. First subscriber arms everything; the last tears down.
 *   - STABLE REFERENCE: reads return the SAME snapshot object until a fold
 *     actually moved (useSyncExternalStore-safe, never an await).
 *
 * Built-in gatherer (this slice): ORPHANED PERMISSIONS from the command
 * queue — the operator-blocking class no surface showed. Present entries
 * fold to needs-you/permission-orphaned; the queue's consumption channel
 * (dequeued/removed = ran · cleared/popped = operator discarded) supplies
 * the terminal fact, so an item leaves honestly, by owner event, never by
 * silence. `sinceMs` is first-observed-in-queue (documented store truth —
 * the queue entry itself carries no timestamp).
 */

import {
  getCommandQueueSnapshot,
  subscribeQueueConsumption,
  subscribeToCommandQueue,
  type QueueConsumptionEvent,
} from '../../input-core/command-queue.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
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

/** A registered owner gatherer: returns the CURRENT owner facts. Pure reads
 *  of the owner's own cache — never I/O on the render path. */
export type AttentionGatherer = () => {
  attention?: readonly AttentionFact[]
  relations?: readonly RelationFact[]
}

interface GathererEntry {
  gather: AttentionGatherer
  /** The owner family's OWN change seam — subscribed only while armed, so
   *  dormancy survives registration. Without it the store recomputes only on
   *  its built-in taps and the family's facts go stale. */
  subscribe?: (cb: () => void) => () => void
  activeUnsub?: (() => void) | null
}

const gatherers = new Set<GathererEntry>()

/** Register an owner-family gatherer (services layers call this at their own
 *  consumer site). Returns remove. Registration alone never arms anything —
 *  dormancy is subscriber-driven; while armed, the family's change seam is
 *  tapped so its facts stay live. */
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

// ── the queue gatherer (built-in) ────────────────────────────────────────────

/** Stable per-entry identity: the queue's reference-identity law makes the
 *  entry object itself the key (snapshots reuse the same objects). */
const permIds = new WeakMap<QueuedCommand, string>()
let permSeq = 0
const permFirstSeen = new WeakMap<QueuedCommand, number>()

function permSubjectId(cmd: QueuedCommand): string {
  let id = permIds.get(cmd)
  if (!id) {
    id = `perm:${cmd.uuid ?? `q${++permSeq}`}`
    permIds.set(cmd, id)
  }
  return id
}

function queueFacts(nowMs: number): AttentionFact[] {
  const facts: AttentionFact[] = []
  for (const cmd of getCommandQueueSnapshot()) {
    if (cmd.mode !== 'orphaned-permission') continue
    if (!permFirstSeen.has(cmd)) permFirstSeen.set(cmd, nowMs)
    const since = permFirstSeen.get(cmd)!
    facts.push({
      subjectId: permSubjectId(cmd),
      owner: 'command-queue',
      sourceEventId: `queue:${permSubjectId(cmd)}`,
      bucket: 'needs-you',
      reasonCode: 'permission-orphaned',
      reasonLabel: 'a permission request is waiting in the queue',
      sinceMs: since,
      atMs: nowMs,
      urgency: 0,
      title: typeof cmd.value === 'string' ? cmd.value : undefined,
    })
  }
  return facts
}

/** Consumption = the owner's terminal event for a queued permission. */
function consumptionFacts(ev: QueueConsumptionEvent, nowMs: number): AttentionFact[] {
  const facts: AttentionFact[] = []
  for (const cmd of ev.commands) {
    if (cmd.mode !== 'orphaned-permission') continue
    const id = permIds.get(cmd)
    if (!id) continue // never observed while queued — nothing to settle
    facts.push({
      subjectId: id,
      owner: 'command-queue',
      sourceEventId: `queue-${ev.kind}:${id}`,
      bucket: 'completed',
      reasonCode: 'settled',
      reasonLabel:
        ev.kind === 'dequeued' || ev.kind === 'removed'
          ? 'the queued permission was consumed'
          : 'the queued permission was discarded',
      sinceMs: permFirstSeen.get(cmd) ?? nowMs,
      atMs: nowMs,
      urgency: 2,
    })
  }
  return facts
}

// ── the store ────────────────────────────────────────────────────────────────

let attention: AttentionState = emptyAttentionState()
let relations: RelationState = emptyRelationState()
let snapshot: AttentionStoreSnapshot = { attention, relations }

let armed = false
let queueUnsub: (() => void) | null = null
let consumptionUnsub: (() => void) | null = null
const listeners = new Set<() => void>()

function recompute(extraFacts?: readonly AttentionFact[]): void {
  const nowMs = Date.now()
  let nextAttention = attention
  let nextRelations = relations
  if (extraFacts && extraFacts.length > 0) {
    nextAttention = foldAttention(nextAttention, extraFacts)
  }
  nextAttention = foldAttention(nextAttention, queueFacts(nowMs))
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
  queueUnsub = subscribeToCommandQueue(() => recompute())
  consumptionUnsub = subscribeQueueConsumption(ev =>
    recompute(consumptionFacts(ev, Date.now())),
  )
  for (const entry of gatherers) {
    entry.activeUnsub = entry.subscribe?.(() => recompute()) ?? null
  }
  recompute()
}

function disarm(): void {
  armed = false
  queueUnsub?.()
  queueUnsub = null
  consumptionUnsub?.()
  consumptionUnsub = null
  for (const entry of gatherers) {
    entry.activeUnsub?.()
    entry.activeUnsub = null
  }
}

/** Subscribe to store changes. First subscriber arms the owner taps; the
 *  last tears them down (solo dormancy). */
export function subscribeAttentionStore(cb: () => void): () => void {
  listeners.add(cb)
  arm()
  return () => {
    listeners.delete(cb)
    if (listeners.size === 0) disarm()
  }
}

/** RENDER-PATH read: the stable-reference snapshot. While dormant this is
 *  the last composed truth (initially empty) — honest, never fabricated. */
export function cachedAttentionStore(): AttentionStoreSnapshot {
  return snapshot
}

/** Whether any consumer is armed — snapshot-shaped surfaces use this to
 *  publish HONEST ABSENCE (no member) instead of a dormant empty state
 *  masquerading as "nothing needs you" (review finding). */
export function isAttentionStoreArmed(): boolean {
  return armed
}

/** Test seams (never product-read). */
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
