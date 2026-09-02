
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

function consumptionFacts(ev: QueueConsumptionEvent, nowMs: number): AttentionFact[] {
  const facts: AttentionFact[] = []
  for (const cmd of ev.commands) {
    if (cmd.mode !== 'orphaned-permission') continue
    const id = permIds.get(cmd)
    if (!id) continue
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
