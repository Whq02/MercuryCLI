// ============================================================================
//  crew/inbox — the conversation-shaped attention inbox.
//
//  PURE: rows fold from conversations + read cursors; the comparator is ONE
//  exported function; nothing here reads I/O. The board renders these rows;
//  agent/session/work-item/artifact are FILTER dimensions, never row keys.
//
// BUCKETS (the exact deterministic order):
//    needs-you → stalled → ready-to-review → working → completed
//  derived from the conversation's UNRESOLVED actionable events (owner-fact
//  event kinds; silence never stalls — 'stalled' needs an explicit failure
//  event, age alone moves nothing):
//    unresolved question/decision  → needs-you
//    unresolved failure            → stalled
//    unresolved review-request     → ready-to-review
//    a completion event, all resolved → completed
//    anything else with activity   → working
//
//  ORDER inside a bucket: explicit priority (higher first) → unresolved age
//  (oldest unresolved event first) → recency LAST → stable id. Recency can
//  never outrank an older direct question (the anti-noise law).
//
//  OPENING LAW: a row opens at the oldest unread-or-unresolved event —
//  oldestUnresolvedOf() — never at the newest noise.
// ============================================================================

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
  /** THE row key — one stable row per conversation. */
  conversationId: CrewConversationId
  bucket: InboxBucket
  title: string
  kind: ConversationV1['kind']
  unreadCount: number
  /** The seq the row OPENS at (oldest unread-or-unresolved), null when read. */
  resumeSeq: number | null
  /** When the oldest unresolved actionable event began (the age basis). */
  unresolvedSinceMs: number | null
  priority?: number
  updatedAt: number
}

/** Derive one row from a conversation + the operator's read cursor. */
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
    // Seqs are contiguous and monotonic, so the TRUE unread count is the seq
    // distance — the retained ring alone undercounts once eviction ran.
    unreadCount: Math.max(0, conversation.lastEventSeq - cursorSeq),
    resumeSeq: resume,
    unresolvedSinceMs: oldestUnresolved?.atMs ?? null,
    ...(conversation.priority !== undefined ? { priority: conversation.priority } : {}),
    updatedAt: conversation.updatedAt,
  }
}

/**
 * THE one comparator: bucket order → explicit priority → unresolved
 * age (oldest first) → recency (the FINAL tie-break) → stable id. Exported
 * pure; exhaustively tested; no surface may sort differently.
 */
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

/** The opening law: the exact seq a deliberate open resumes at. */
export function oldestUnresolvedOf(conversation: ConversationV1, cursorSeq: number): number | null {
  return deriveInboxRow(conversation, cursorSeq).resumeSeq
}

/** Fold conversations + cursors into the sorted inbox. `relevant` filters to
 *  the personally relevant set (the caller supplies owner facts); default:
 *  everything in the registry (already operator-scoped by construction). */
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
