// ============================================================================
//  crew/conversations — the conversation registry.
//
//  ConversationId is the STABLE identity of a thread — never a composite of
//  agent/session/work-item, never re-minted by a handoff. A conversation
//  carries participants (ActorRefV1 — humans stay principals), optional
//  session/work-item/artifact refs, an explicit lineage ledger
//  (parent/branch/handoff — lineage NEVER merges transcripts), and a bounded
//  ordered event ring with per-operator read cursors:
//    · unread position belongs to (operator, conversation) — not to a surface;
//    · mark-read commits the EXACT cursor, only after presentation (the
//      caller commits post-render);
//    · oldest-unread/unresolved is the opening law (inbox.ts owns the fold).
//
//  Console side questions and Minerva refinements mint NEW conversations
//  with parent lineage by default; only a deliberate open of a known thread
//  reuses its id; a handoff records an edge on BOTH sides and changes NO id.
// ============================================================================

import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { crewStoreRoot, type ActorRefV1 } from './identity.js'

export type CrewConversationId = string & { readonly __brand: 'CrewConversationId' }

/** The project's MAIN thread — ONE declared id every surface adopts (the
 *  store is already project-keyed, so this is per-project by construction). */
export const MAIN_CONVERSATION_ID = 'cv-main' as CrewConversationId

export const CONVERSATION_KINDS = [
  'main',
  'console-side',
  'minerva-refinement',
  'work',
  'artifact',
  'direct',
] as const
export type ConversationKind = (typeof CONVERSATION_KINDS)[number]

export const CONVERSATION_EVENT_KINDS = [
  'message',
  'question',
  'review-request',
  'failure',
  'activity',
  'delivery',
  'decision',
  'completion',
] as const
export type ConversationEventKind = (typeof CONVERSATION_EVENT_KINDS)[number]

export interface ConversationEventV1 {
  seq: number
  kind: ConversationEventKind
  atMs: number
  /** A ref into the owning surface (mercury://…, receipt id, frame id). */
  ref?: string
  label?: string
  /** An event the operator must act on; resolved by seq. */
  requiresResolution?: boolean
  resolvedAtMs?: number
  actor?: ActorRefV1
}

export interface ConversationLineageV1 {
  kind: 'parent' | 'branch' | 'handoff'
  direction: 'from' | 'to'
  otherConversationId: CrewConversationId
  atMs: number
  ref?: string
}

export interface ConversationV1 {
  schema: 1
  conversationId: CrewConversationId
  kind: ConversationKind
  title: string
  participants: ActorRefV1[]
  sessionRefs: string[]
  workItemRefs: string[]
  artifactRefs: string[]
  lineage: ConversationLineageV1[]
  /** Monotonic per-conversation event counter (ring may evict, seq never rewinds). */
  lastEventSeq: number
  /** Bounded ordered ring, oldest first. */
  events: ConversationEventV1[]
  /** Explicit operator-set priority (higher first; absent = none). */
  priority?: number
  createdAt: number
  updatedAt: number
}

interface ConversationFile {
  conversations: Record<string, ConversationV1>
  /** `${operatorId}|${conversationId}` → last PRESENTED seq. */
  cursors: Record<string, { seq: number; committedAt: number }>
}

const MAX_CONVERSATIONS = 300
const MAX_EVENTS_PER_CONVERSATION = 100

function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

const conversationStore = defineStore<ConversationFile, [dir?: string]>({
  name: 'crew-conversations',
  path: (dir?: string) =>
    join(crewStoreRoot(dir), `conversations-${projectKey()}.json`),
  schemaVersion: 1,
  decode: raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const r = raw as Partial<ConversationFile>
    const out: ConversationFile = { conversations: {}, cursors: {} }
    if (r.conversations && typeof r.conversations === 'object' && !Array.isArray(r.conversations)) {
      for (const [id, c] of Object.entries(r.conversations)) {
        if (c && typeof c === 'object' && typeof (c as ConversationV1).kind === 'string') {
          out.conversations[id] = c as ConversationV1
        }
      }
    }
    if (r.cursors && typeof r.cursors === 'object' && !Array.isArray(r.cursors)) {
      for (const [k, v] of Object.entries(r.cursors)) {
        if (v && typeof v === 'object' && typeof (v as { seq?: unknown }).seq === 'number') {
          out.cursors[k] = v as { seq: number; committedAt: number }
        }
      }
    }
    return out
  },
  empty: () => ({ conversations: {}, cursors: {} }),
  onReadFailure: 'empty',
})

export interface MintConversationArgs {
  kind: ConversationKind
  title: string
  participants: ActorRefV1[]
  /** Parent lineage (console-side/minerva default): the source conversation. */
  parentConversationId?: CrewConversationId
  sessionRefs?: string[]
  workItemRefs?: string[]
  artifactRefs?: string[]
  /** Adopt a declared id (deliberate cross-surface open of a KNOWN thread —
   *  never derived from display text). */
  adoptId?: CrewConversationId
  dir?: string
}

export async function mintConversation(args: MintConversationArgs): Promise<ConversationV1> {
  const store = conversationStore(args.dir)
  return store.update<ConversationV1>(current => {
    if (args.adoptId && current.conversations[args.adoptId]) {
      return { next: current, result: current.conversations[args.adoptId]! }
    }
    const conversationId = (args.adoptId ??
      (`cv-${randomUUID().replace(/-/g, '').slice(0, 12)}` as CrewConversationId)) as CrewConversationId
    const now = Date.now()
    const conversation: ConversationV1 = {
      schema: 1,
      conversationId,
      kind: args.kind,
      title: args.title,
      participants: args.participants,
      sessionRefs: args.sessionRefs ?? [],
      workItemRefs: args.workItemRefs ?? [],
      artifactRefs: args.artifactRefs ?? [],
      lineage:
        args.parentConversationId !== undefined
          ? [{ kind: 'parent', direction: 'to', otherConversationId: args.parentConversationId, atMs: now }]
          : [],
      lastEventSeq: 0,
      events: [],
      createdAt: now,
      updatedAt: now,
    }
    let conversations: Record<string, ConversationV1> = {
      ...current.conversations,
      [conversationId]: conversation,
    }
    // The parent side records the child edge too (lineage is explicit BOTH ways).
    if (args.parentConversationId && conversations[args.parentConversationId]) {
      const parent = conversations[args.parentConversationId]!
      conversations[args.parentConversationId] = {
        ...parent,
        lineage: [
          ...parent.lineage,
          { kind: 'parent', direction: 'from', otherConversationId: conversationId, atMs: now },
        ],
        updatedAt: now,
      }
    }
    let cursors = current.cursors
    const ids = Object.keys(conversations)
    if (ids.length > MAX_CONVERSATIONS) {
      // Evict RESOLVED threads first (no unresolved actionable event), oldest
      // first — a thread still owing the operator an answer drops only when
      // no settled victim remains (the wave-A terminal-first eviction law).
      // The MAIN thread is never evicted (every surface adopts its declared
      // id; a re-adopt would rewind seq 0 against persisted cursors).
      const owesNothing = (c: ConversationV1): boolean =>
        !c.events.some(e => e.requiresResolution === true && e.resolvedAtMs === undefined)
      const evictable = (c: ConversationV1): boolean =>
        c.conversationId !== conversationId && (c.conversationId as string) !== (MAIN_CONVERSATION_ID as string)
      const byAge = Object.values(conversations).sort((a, b) => a.updatedAt - b.updatedAt)
      let toDrop = byAge.length - MAX_CONVERSATIONS
      const dropSet = new Set<ConversationV1>()
      for (const c of byAge) {
        if (toDrop === 0) break
        if (evictable(c) && owesNothing(c)) {
          dropSet.add(c)
          toDrop--
        }
      }
      for (const c of byAge) {
        if (toDrop === 0) break
        if (evictable(c) && !dropSet.has(c)) {
          dropSet.add(c)
          toDrop--
        }
      }
      conversations = {}
      for (const c of byAge) {
        if (!dropSet.has(c)) conversations[c.conversationId] = c
      }
      conversations[conversationId] = conversation
      // Cursors for evicted threads go with them (no unbounded orphan growth).
      const evictedIds = new Set([...dropSet].map(c => c.conversationId as string))
      cursors = Object.fromEntries(
        Object.entries(current.cursors).filter(([key]) => {
          const sep = key.indexOf('|')
          return sep < 0 || !evictedIds.has(key.slice(sep + 1))
        }),
      )
    }
    return { next: { ...current, conversations, cursors }, result: conversation }
  })
}

export async function conversationOf(
  conversationId: string,
  opts?: { dir?: string },
): Promise<ConversationV1 | null> {
  const file = await conversationStore(opts?.dir).read()
  return file.conversations[conversationId] ?? null
}

export async function listConversations(opts?: { dir?: string }): Promise<ConversationV1[]> {
  const file = await conversationStore(opts?.dir).read()
  return Object.values(file.conversations)
}

/** Append one event; returns the assigned seq. The ring is bounded but the
 *  counter never rewinds (cursors stay meaningful across eviction). */
/** The ring trim: RESOLVED/non-actionable events drop first — an UNRESOLVED
 *  obligation (question/failure/review-request awaiting the operator) is
 *  never silently aged out by later noise; only when the whole ring is open
 *  obligations does the oldest one drop (bounded either way). ONE owner —
 *  every append path (plain + upsert) must ride it (final audit: the atomic
 *  upsert grew the ring unbounded). */
function trimEventRing(events: ConversationEventV1[]): ConversationEventV1[] {
  if (events.length <= MAX_EVENTS_PER_CONVERSATION) return events
  let toDrop = events.length - MAX_EVENTS_PER_CONVERSATION
  const dropSet = new Set<ConversationEventV1>()
  for (const e of events) {
    if (toDrop === 0) break
    if (!(e.requiresResolution === true && e.resolvedAtMs === undefined)) {
      dropSet.add(e)
      toDrop--
    }
  }
  for (const e of events) {
    if (toDrop === 0) break
    if (!dropSet.has(e)) {
      dropSet.add(e)
      toDrop--
    }
  }
  return events.filter(e => !dropSet.has(e))
}

export async function appendConversationEvent(
  conversationId: CrewConversationId,
  event: Omit<ConversationEventV1, 'seq' | 'atMs'> & { atMs?: number },
  opts?: { dir?: string },
): Promise<number | null> {
  const store = conversationStore(opts?.dir)
  return store.update<number | null>(current => {
    const c = current.conversations[conversationId]
    if (!c) return { next: current, result: null }
    const seq = c.lastEventSeq + 1
    const record: ConversationEventV1 = { ...event, seq, atMs: event.atMs ?? Date.now() }
    const events = trimEventRing([...c.events, record])
    return {
      next: {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: { ...c, lastEventSeq: seq, events, updatedAt: record.atMs },
        },
      },
      result: seq,
    }
  })
}

/**
 * Append an event ONLY when no UNRESOLVED event with the same (kind, ref)
 * exists — dedupe and append are ONE store mutation, so two racing mirrors
 * can never double-post the same obligation. Returns the open event's seq
 * (existing or newly appended), or null when the conversation is absent.
 */
export async function upsertUnresolvedEvent(
  conversationId: CrewConversationId,
  event: Omit<ConversationEventV1, 'seq' | 'atMs' | 'requiresResolution'> & { atMs?: number },
  opts?: { dir?: string },
): Promise<number | null> {
  const store = conversationStore(opts?.dir)
  return store.update<number | null>(current => {
    const c = current.conversations[conversationId]
    if (!c) return { next: current, result: null }
    const open = c.events.find(
      e => e.kind === event.kind && e.ref === event.ref && e.requiresResolution === true && e.resolvedAtMs === undefined,
    )
    if (open) return { next: current, result: open.seq }
    const seq = c.lastEventSeq + 1
    const record: ConversationEventV1 = { ...event, seq, requiresResolution: true, atMs: event.atMs ?? Date.now() }
    const events = trimEventRing([...c.events, record])
    return {
      next: {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: { ...c, lastEventSeq: seq, events, updatedAt: record.atMs },
        },
      },
      result: seq,
    }
  })
}

/**
 * Resolve the OLDEST unresolved event matching (kind, ref) — the find and
 * the stamp are ONE store mutation. Returns the resolved seq, or null when
 * nothing matched (the caller decides whether absence is a race or a no-op).
 */
export async function resolveEventByRef(
  conversationId: CrewConversationId,
  kind: ConversationEventKind,
  ref: string,
  opts?: { dir?: string },
): Promise<number | null> {
  const store = conversationStore(opts?.dir)
  return store.update<number | null>(current => {
    const c = current.conversations[conversationId]
    if (!c) return { next: current, result: null }
    const ix = c.events.findIndex(
      e => e.kind === kind && e.ref === ref && e.requiresResolution === true && e.resolvedAtMs === undefined,
    )
    if (ix < 0) return { next: current, result: null }
    const events = [...c.events]
    events[ix] = { ...events[ix]!, resolvedAtMs: Date.now() }
    return {
      next: {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: { ...c, events, updatedAt: Date.now() },
        },
      },
      result: events[ix]!.seq,
    }
  })
}

/** Resolve an actionable event (decision made, question answered). */
export async function resolveConversationEvent(
  conversationId: CrewConversationId,
  seq: number,
  opts?: { dir?: string },
): Promise<boolean> {
  const store = conversationStore(opts?.dir)
  return store.update<boolean>(current => {
    const c = current.conversations[conversationId]
    if (!c) return { next: current, result: false }
    const ix = c.events.findIndex(e => e.seq === seq)
    if (ix < 0 || c.events[ix]!.resolvedAtMs !== undefined) {
      return { next: current, result: false }
    }
    const events = [...c.events]
    events[ix] = { ...events[ix]!, resolvedAtMs: Date.now() }
    return {
      next: {
        ...current,
        conversations: {
          ...current.conversations,
          [conversationId]: { ...c, events, updatedAt: Date.now() },
        },
      },
      result: true,
    }
  })
}

/**
 * Record an explicit link (branch/handoff) between two conversations. Both
 * sides gain the edge; NEITHER id changes and no transcript moves — a
 * handoff is lineage plus a typed delivery, never a merge.
 */
export async function linkConversation(
  fromConversationId: CrewConversationId,
  toConversationId: CrewConversationId,
  kind: 'branch' | 'handoff',
  opts?: { ref?: string; dir?: string },
): Promise<boolean> {
  const store = conversationStore(opts?.dir)
  return store.update<boolean>(current => {
    const from = current.conversations[fromConversationId]
    const to = current.conversations[toConversationId]
    if (!from || !to) return { next: current, result: false }
    const now = Date.now()
    return {
      next: {
        ...current,
        conversations: {
          ...current.conversations,
          [fromConversationId]: {
            ...from,
            lineage: [
              ...from.lineage,
              {
                kind,
                direction: 'from',
                otherConversationId: toConversationId,
                atMs: now,
                ...(opts?.ref !== undefined ? { ref: opts.ref } : {}),
              },
            ],
            updatedAt: now,
          },
          [toConversationId]: {
            ...to,
            lineage: [
              ...to.lineage,
              {
                kind,
                direction: 'to',
                otherConversationId: fromConversationId,
                atMs: now,
                ...(opts?.ref !== undefined ? { ref: opts.ref } : {}),
              },
            ],
            updatedAt: now,
          },
        },
      },
      result: true,
    }
  })
}

/** Explicit operator-set priority (higher sorts first inside a bucket;
 *  undefined clears). Presentation weight only — never identity. */
export async function setConversationPriority(
  conversationId: CrewConversationId,
  priority: number | undefined,
  opts?: { dir?: string },
): Promise<boolean> {
  const store = conversationStore(opts?.dir)
  return store.update<boolean>(current => {
    const c = current.conversations[conversationId]
    if (!c) return { next: current, result: false }
    const { priority: _old, ...rest } = c
    const updated: ConversationV1 = {
      ...rest,
      ...(priority !== undefined ? { priority } : {}),
      updatedAt: Date.now(),
    }
    return {
      next: { ...current, conversations: { ...current.conversations, [conversationId]: updated } },
      result: true,
    }
  })
}

/** The (operator, conversation) read cursor — the last PRESENTED seq. */
export async function readCursorOf(
  operatorId: string,
  conversationId: CrewConversationId,
  opts?: { dir?: string },
): Promise<number> {
  const file = await conversationStore(opts?.dir).read()
  return file.cursors[`${operatorId}|${conversationId}`]?.seq ?? 0
}

/** Every cursor one operator holds — ONE store read (the inbox fold reads
 *  this beside listConversations instead of N per-row reads). */
export async function listReadCursors(
  operatorId: string,
  opts?: { dir?: string },
): Promise<Map<CrewConversationId, number>> {
  const file = await conversationStore(opts?.dir).read()
  const out = new Map<CrewConversationId, number>()
  const prefix = `${operatorId}|`
  for (const [key, v] of Object.entries(file.cursors)) {
    if (key.startsWith(prefix)) out.set(key.slice(prefix.length) as CrewConversationId, v.seq)
  }
  return out
}

/** Commit the exact presented cursor (callers commit AFTER rendering; a
 *  cursor never moves backwards). */
export async function commitReadCursor(
  operatorId: string,
  conversationId: CrewConversationId,
  seq: number,
  opts?: { dir?: string },
): Promise<void> {
  const store = conversationStore(opts?.dir)
  await store.mutate(current => {
    const key = `${operatorId}|${conversationId}`
    const existing = current.cursors[key]
    if (existing && existing.seq >= seq) return current
    return {
      ...current,
      cursors: { ...current.cursors, [key]: { seq, committedAt: Date.now() } },
    }
  })
}

/** Subscription seam for the projections/boards. */
export function subscribeConversations(cb: () => void, opts?: { dir?: string }): () => void {
  return conversationStore(opts?.dir).subscribe(() => cb(), { immediate: false })
}

/**
 * The one-shot operator re-key (ledger L27): every record in THIS store
 * keyed by a LEGACY operator id — conversation participants, event actors,
 * and the `${operatorId}|${conversationId}` read-cursor keys — moves to the
 * keyed id in ONE store mutation. Write new, delete old: a moved cursor
 * keeps the furthest of the two positions when both spellings exist, and a
 * later run finds nothing legacy to touch (idempotent; the crew boot calls
 * this every boot for exactly that reason). Returns the substitution count.
 */
export async function rekeyOperatorRecords(
  legacyIds: readonly string[],
  newId: string,
  opts?: { dir?: string },
): Promise<number> {
  if (legacyIds.length === 0) return 0
  const { rekeyLegacyOperatorIds } = await import('../../substrate/identity/rekey.js')
  const store = conversationStore(opts?.dir)
  return store.update<number>(current => {
    let changed = 0
    let conversations: Record<string, ConversationV1> | null = null
    for (const [id, c] of Object.entries(current.conversations)) {
      const rekeyed = rekeyLegacyOperatorIds(c, legacyIds, newId)
      if (rekeyed.changed > 0) {
        if (!conversations) conversations = { ...current.conversations }
        conversations[id] = rekeyed.value
        changed += rekeyed.changed
      }
    }
    let cursors: Record<string, { seq: number; committedAt: number }> | null = null
    for (const [key, v] of Object.entries(current.cursors)) {
      const sep = key.indexOf('|')
      if (sep <= 0) continue
      const owner = key.slice(0, sep)
      if (!legacyIds.includes(owner)) continue
      if (!cursors) cursors = { ...current.cursors }
      const nk = `${newId}${key.slice(sep)}`
      const existing = cursors[nk]
      // A cursor never moves backwards — the merged position is the furthest.
      if (!existing || v.seq > existing.seq) cursors[nk] = v
      delete cursors[key]
      changed++
    }
    if (changed === 0) return { next: current, result: 0 }
    return {
      next: {
        conversations: conversations ?? current.conversations,
        cursors: cursors ?? current.cursors,
      },
      result: changed,
    }
  })
}
