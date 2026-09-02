
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineStore } from '../../substrate/fileStore.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { crewStoreRoot, type ActorRefV1 } from './identity.js'

export type CrewConversationId = string & { readonly __brand: 'CrewConversationId' }

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
  ref?: string
  label?: string
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
  lastEventSeq: number
  events: ConversationEventV1[]
  priority?: number
  createdAt: number
  updatedAt: number
}

interface ConversationFile {
  conversations: Record<string, ConversationV1>
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
  parentConversationId?: CrewConversationId
  sessionRefs?: string[]
  workItemRefs?: string[]
  artifactRefs?: string[]
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

export async function readCursorOf(
  operatorId: string,
  conversationId: CrewConversationId,
  opts?: { dir?: string },
): Promise<number> {
  const file = await conversationStore(opts?.dir).read()
  return file.cursors[`${operatorId}|${conversationId}`]?.seq ?? 0
}

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

export function subscribeConversations(cb: () => void, opts?: { dir?: string }): () => void {
  return conversationStore(opts?.dir).subscribe(() => cb(), { immediate: false })
}

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
