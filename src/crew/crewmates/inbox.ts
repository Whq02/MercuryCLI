
import type { ConversationV1, CrewConversationId } from './conversations.js'

export const INBOX_BUCKET_ORDER = [
  'needs-you',
  'stalled',
  'ready-to-review',
  'working',
  'completed',
] as const
export type InboxBucket = (typeof INBOX_BUCKET_ORDER)[number]

export interface InboxRowV1 {
  conversationId: CrewConversationId
  bucket: InboxBucket
  title: string
  kind: ConversationV1['kind']
  unreadCount: number
  resumeSeq: number | null
  unresolvedSinceMs: number | null
  priority?: number
  updatedAt: number
}

export function deriveInboxRow(conversation: ConversationV1, cursorSeq: number): InboxRowV1 {
  const unresolved = conversation.events.filter(
    e => e.requiresResolution === true && e.resolvedAtMs === undefined,
  )
  const byKind = (kind: string): boolean => unresolved.some(e => e.kind === kind)
  const hasCompletion = conversation.events.some(e => e.kind === 'completion')
  const bucket: InboxBucket =
    byKind('question') || byKind('decision')
      ? 'needs-you'
      : byKind('failure')
        ? 'stalled'
        : byKind('review-request')
          ? 'ready-to-review'
          : hasCompletion && unresolved.length === 0
            ? 'completed'
            : 'working'
  const unread = conversation.events.filter(e => e.seq > cursorSeq)
  const oldestUnresolved = unresolved.length > 0 ? unresolved.reduce((a, b) => (a.seq <= b.seq ? a : b)) : null
  const oldestUnread = unread.length > 0 ? unread.reduce((a, b) => (a.seq <= b.seq ? a : b)) : null
  const resume =
    oldestUnresolved && oldestUnread
      ? Math.min(oldestUnresolved.seq, oldestUnread.seq)
      : (oldestUnresolved?.seq ?? oldestUnread?.seq ?? null)
  return {
    conversationId: conversation.conversationId,
    bucket,
    title: conversation.title,
    kind: conversation.kind,
    unreadCount: Math.max(0, conversation.lastEventSeq - cursorSeq),
    resumeSeq: resume,
    unresolvedSinceMs: oldestUnresolved?.atMs ?? null,
    ...(conversation.priority !== undefined ? { priority: conversation.priority } : {}),
    updatedAt: conversation.updatedAt,
  }
}

export function compareInboxRows(a: InboxRowV1, b: InboxRowV1): number {
  const ba = INBOX_BUCKET_ORDER.indexOf(a.bucket)
  const bb = INBOX_BUCKET_ORDER.indexOf(b.bucket)
  if (ba !== bb) return ba - bb
  const pa = a.priority ?? 0
  const pb = b.priority ?? 0
  if (pa !== pb) return pb - pa
  const ua = a.unresolvedSinceMs ?? Number.MAX_SAFE_INTEGER
  const ub = b.unresolvedSinceMs ?? Number.MAX_SAFE_INTEGER
  if (ua !== ub) return ua - ub
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0
}

export function oldestUnresolvedOf(conversation: ConversationV1, cursorSeq: number): number | null {
  return deriveInboxRow(conversation, cursorSeq).resumeSeq
}

export function deriveInbox(
  conversations: readonly ConversationV1[],
  cursorOf: (conversationId: CrewConversationId) => number,
  relevant?: (c: ConversationV1) => boolean,
): InboxRowV1[] {
  return conversations
    .filter(c => (relevant ? relevant(c) : true))
    .map(c => deriveInboxRow(c, cursorOf(c.conversationId)))
    .sort(compareInboxRows)
}
