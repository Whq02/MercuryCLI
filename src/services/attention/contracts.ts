/**
 * attention contracts — the typed vocabulary and the PURE fold of
 * the operator attention projection (the five owner-truth buckets).
 *
 * HONEST-ATTENTION LAW:
 *   - An item enters a bucket ONLY from an owner fact. The fold never
 *     invents, never infers, and carries the owner's own event id on every
 *     item — `sourceEventId` is the receipt that a real owner said so.
 *   - SILENCE NEVER STALLS: there are no time-based transitions in the fold.
 *     'stalled' exists only as an explicit owner fact (runManifest status,
 *     RunLiveness verdict, roster dead-seat row, task blockedBy, exhausted
 *     retries). Age alone moves nothing.
 *   - Content-derived signals (agentStateClassifier, agentStateSnapshot) are
 *     DECORATION ONLY — they may enrich presentation downstream, never mint
 *     or move an item here. The severed attentionDerive count leaf keeps its
 *     invariants (pending-only · unknown ≠ zero); this module is the
 *     projection that port was waiting for.
 *
 * FOLD LAWS (proved by scripts/attention/prove-attention-fold.ts):
 *   idempotent replay · rebuilt ≡ live-incremental · stable identity across
 *   bucket moves (one item per subject, keyed by subjectId) · sort is
 *   urgency → waiting-time (longest first) → stable id, never recency.
 *
 * The incremental store, owner gatherers and the view-model live beside this
 * file (store.ts, the A2 view-model) — this module stays pure and I/O-free.
 */

/** The five owner-truth buckets, in board order. */
export const ATTENTION_BUCKETS = [
  'needs-you',
  'ready-to-review',
  'stalled',
  'working',
  'completed',
] as const
export type AttentionBucket = (typeof ATTENTION_BUCKETS)[number]

/** The owner families a fact may come from (ONE named owner per reasonCode —
 *  the R0 map). */
export type AttentionOwner =
  | 'command-queue'
  | 'work-queue'
  | 'review-queue'
  | 'run-manifest'
  | 'roster'
  | 'collab'
  | 'agent-results'
  | 'steering'
  | 'tasks'
  | 'side-question'
  // the durable needs-you obligation owner
  // (src/services/crew/obligations.ts via obligationsBridge).
  | 'obligations'

/** Machine-readable reasons — each maps to exactly one owner event family. */
export type AttentionReasonCode =
  // needs-you
  | 'permission-orphaned'
  | 'permission-pending'
  | 'question-pending'
  | 'ticket-decision'
  | 'collab-decision'
  // ready-to-review
  | 'review-queued'
  // stalled (explicit owner facts ONLY)
  | 'run-paused'
  | 'run-failed'
  | 'run-killed'
  | 'run-wedged'
  | 'run-orphaned'
  | 'teammate-dead'
  | 'dependency-blocked'
  | 'retries-exhausted'
  // working
  | 'run-live'
  | 'turn-active'
  // completed
  | 'run-completed'
  | 'ticket-decided'
  | 'settled'

/** 0 = blocking the operator now · 1 = wants the operator · 2 = ambient. */
export type AttentionUrgency = 0 | 1 | 2

/**
 * One owner fact — the fold's ONLY input. Gatherers (store.ts) translate
 * owner events into these; the fold trusts them verbatim.
 */
export interface AttentionFact {
  /** Stable item identity across regroupings: `<family>:<subject>`. */
  subjectId: string
  owner: AttentionOwner
  /** The owner's own event/frame/row id — the receipt. */
  sourceEventId: string
  bucket: AttentionBucket
  reasonCode: AttentionReasonCode
  reasonLabel: string
  /** When the owner fact began (the waiting-time basis). */
  sinceMs: number
  /** When the fact was observed (recency is DISPLAY data, never sort-primary). */
  atMs: number
  urgency: AttentionUrgency
  /** Optional display title for the subject (session goal, ticket ask …). */
  title?: string
}

/** One projected item — the latest owner truth for a subject. */
export interface AttentionItem {
  subjectId: string
  owner: AttentionOwner
  sourceEventId: string
  bucket: AttentionBucket
  reasonCode: AttentionReasonCode
  reasonLabel: string
  sinceMs: number
  atMs: number
  urgency: AttentionUrgency
  title?: string
}

export interface AttentionState {
  /** subjectId → item. Insertion order is irrelevant; sort is a read law. */
  items: ReadonlyMap<string, AttentionItem>
}

export function emptyAttentionState(): AttentionState {
  return { items: new Map() }
}

/**
 * The PURE fold: apply owner facts to the state. A later fact for the same
 * subject replaces its item (stable identity, bucket may move); an identical
 * fact is a no-op (idempotent replay). `atMs` orders facts for one subject —
 * an older duplicate never regresses a newer truth.
 */
export function foldAttention(
  state: AttentionState,
  facts: readonly AttentionFact[],
): AttentionState {
  if (facts.length === 0) return state
  let items: Map<string, AttentionItem> | null = null
  for (const f of facts) {
    const prev = (items ?? state.items).get(f.subjectId)
    if (prev) {
      // Idempotence: the same owner event again changes nothing.
      if (prev.sourceEventId === f.sourceEventId && prev.bucket === f.bucket) continue
      // A stale fact (older than what we hold) never regresses the item.
      if (f.atMs < prev.atMs) continue
    }
    if (!items) items = new Map(state.items)
    items.set(f.subjectId, {
      subjectId: f.subjectId,
      owner: f.owner,
      sourceEventId: f.sourceEventId,
      bucket: f.bucket,
      reasonCode: f.reasonCode,
      reasonLabel: f.reasonLabel,
      sinceMs: f.sinceMs,
      atMs: f.atMs,
      urgency: f.urgency,
      ...(f.title !== undefined ? { title: f.title } : {}),
    })
  }
  return items ? { items } : state
}

/** The items, unordered (sortAttention is the one read-order law). */
export function attentionItems(state: AttentionState): AttentionItem[] {
  return [...state.items.values()]
}

/**
 * The ONE sort law: urgency (0 first) → waiting-time (LONGEST first — the
 * oldest `sinceMs` wins) → stable id. `nowMs` is accepted for symmetry with
 * display (waiting = now - sinceMs) but the order never depends on it:
 * longest-waiting is oldest-sinceMs regardless of the clock. Recency (atMs)
 * is deliberately absent — never primarily by recency.
 */
export function sortAttention(items: readonly AttentionItem[], _nowMs?: number): AttentionItem[] {
  return [...items].sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency - b.urgency
    if (a.sinceMs !== b.sinceMs) return a.sinceMs - b.sinceMs
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0
  })
}

/** Items of one bucket, in the sort law's order. */
export function bucketItems(
  state: AttentionState,
  bucket: AttentionBucket,
  nowMs?: number,
): AttentionItem[] {
  return sortAttention(
    attentionItems(state).filter(i => i.bucket === bucket),
    nowMs,
  )
}
