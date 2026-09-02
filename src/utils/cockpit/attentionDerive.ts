// ============================================================================
//  utils/cockpit/attentionDerive — the ONE attention derivation.
//
//  How many sessions are blocked on an operator decision RIGHT NOW (pending
//  tool-permission requests + pending AskUserQuestion prompts), folded from
//  the durable needs-input queue's `status:'pending'` rows — the same queue
//  the rest of Mercury consumes.
//
//  A leaf, framework-agnostic: no React, no Ink, no I/O. It folds a
//  needs-input items array passed IN and returns the honest attention count +
//  the two sub-counts. A surface (a frame badge, a roster header, a statusbar
//  pip) consumes it; the caller owns the read.
//
//  Honest-state invariants:
//   - PENDING ONLY. The queue also carries `status:'stale'` rows (dead-session
//     residue, kept for a grey listing); counting those over-counts attention.
//   - Transient failure ≠ zero. `unknown` is a distinct state: a read that
//     could not resolve returns { unknown:true, count:0 } so a consumer keeps
//     the last-known value instead of clearing the badge. A genuinely-empty
//     resolved queue returns { unknown:false, count:0 } — the honest "nothing
//     needs you" state.
//   - Total over bad input; never throws. Garbage rows are skipped, never
//     invented into attention.
// ============================================================================

/** The needs-input kinds that constitute an OPERATOR-BLOCKING decision: a
 *  pending tool-permission request or a pending clarifying question is a
 *  session blocked on you. Other needs-input kinds keep their own surfaces and
 *  are NOT attention. */
export const ATTENTION_KINDS = new Set<string>([
  'tool_permission_request',
  'clarifying_question',
])

/** A single needs-input queue item (the input contract). Open shape: only the
 *  fields below are read (status / kind / sessionId); extra keys are harmless. */
export interface NeedsInputItem {
  /** the durable queue status — only 'pending' counts as live attention. */
  status?: string
  /** the request kind — must be an ATTENTION_KINDS member to count. */
  kind?: string
  /** the blocked session (used to dedup so one session counts once). */
  sessionId?: string
  [extra: string]: unknown
}

/** The derived attention signal. */
export interface AttentionCount {
  /** Total distinct sessions blocked on an operator decision right now. */
  count: number
  /** Pending tool-permission requests (sub-count, distinct sessions). */
  permissions: number
  /** Pending clarifying questions (sub-count, distinct sessions). */
  questions: number
  /** True when the queue could not be resolved (transient read failure). In
   *  this state `count` is 0 but the caller MUST treat it as unknown ≠ zero —
   *  keep the last-known badge, do not clear it. False ⇒ a resolved queue (an
   *  honest empty when count is 0). */
  unknown: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0

const UNKNOWN: AttentionCount = { count: 0, permissions: 0, questions: 0, unknown: true }
const EMPTY: AttentionCount = { count: 0, permissions: 0, questions: 0, unknown: false }

/**
 * deriveAttentionCount — fold a needs-input queue into the honest attention
 * count: how many distinct sessions are blocked on an operator decision now.
 *
 * @param items the needs-input rows (the /api/needs-input queue, or whatever the
 *   harness can read). `null` / `undefined` / non-array ⇒ the UNKNOWN state
 *   ({ unknown:true }) — a transient read failure, NOT a real empty (unknown ≠
 *   zero). A real empty array ⇒ { unknown:false, count:0 } (honest "nothing").
 * @returns the derived count. Pure; never throws; total over bad input.
 */
export function deriveAttentionCount(
  items: readonly NeedsInputItem[] | null | undefined,
): AttentionCount {
  // A missing/garbage source folds to UNKNOWN, never a faked-empty zero. The
  // source-of-truth contract: a read that did not resolve must not clear the
  // badge to zero (attention.ts: "unknown ≠ zero, per the header contract").
  if (!Array.isArray(items)) return UNKNOWN
  if (items.length === 0) return EMPTY

  // Dedup by session: one blocked session is ONE pending decision even if the
  // queue carries multiple rows for it (mirrors the count-once intent — a title
  // that double-counts a session re-tells the over-count lie). A row with no
  // sessionId still counts once (keyed by a row-local fallback).
  const permSessions = new Set<string>()
  const qSessions = new Set<string>()
  let anonPerms = 0
  let anonQuestions = 0

  for (const it of items) {
    // pending ONLY — stale residue is kept by the route for a grey listing but
    // must never be counted as live attention.
    if (!isObj(it) || it.status !== 'pending') continue
    const kind = isStr(it.kind) ? it.kind : ''
    if (!ATTENTION_KINDS.has(kind)) continue
    const sid = isStr(it.sessionId) ? it.sessionId : null
    if (kind === 'tool_permission_request') {
      if (sid) permSessions.add(sid)
      else anonPerms += 1
    } else {
      // 'clarifying_question'
      if (sid) qSessions.add(sid)
      else anonQuestions += 1
    }
  }

  const permissions = permSessions.size + anonPerms
  const questions = qSessions.size + anonQuestions
  return { count: permissions + questions, permissions, questions, unknown: false }
}

/** Reconcile a freshly-derived count against the last-known one, honouring the
 *  unknown ≠ zero contract: if the new read is UNKNOWN (transient failure),
 *  keep the previous count rather than clearing the badge. A resolved read
 *  (unknown:false) always wins, even when it is an honest zero. This is the
 *  pure equivalent of attention.ts's `if (r.failed) return` guard, so a
 *  polling consumer never blinks the badge to 0 on a single hiccup. */
export function reconcileAttention(
  prev: AttentionCount | null | undefined,
  next: AttentionCount,
): AttentionCount {
  if (next.unknown && prev && !prev.unknown) return prev
  return next
}
