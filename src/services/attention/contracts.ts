
export const ATTENTION_BUCKETS = [
  'needs-you',
  'ready-to-review',
  'stalled',
  'working',
  'completed',
] as const
export type AttentionBucket = (typeof ATTENTION_BUCKETS)[number]

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
  | 'obligations'

export type AttentionReasonCode =
  | 'permission-orphaned'
  | 'permission-pending'
  | 'question-pending'
  | 'ticket-decision'
  | 'collab-decision'
  | 'review-queued'
  | 'run-paused'
  | 'run-failed'
  | 'run-killed'
  | 'run-wedged'
  | 'run-orphaned'
  | 'teammate-dead'
  | 'dependency-blocked'
  | 'retries-exhausted'
  | 'run-live'
  | 'turn-active'
  | 'run-completed'
  | 'ticket-decided'
  | 'settled'

export type AttentionUrgency = 0 | 1 | 2

export interface AttentionFact {
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
  items: ReadonlyMap<string, AttentionItem>
}

export function emptyAttentionState(): AttentionState {
  return { items: new Map() }
}

export function foldAttention(
  state: AttentionState,
  facts: readonly AttentionFact[],
): AttentionState {
  if (facts.length === 0) return state
  let items: Map<string, AttentionItem> | null = null
  for (const f of facts) {
    const prev = (items ?? state.items).get(f.subjectId)
    if (prev) {
      if (prev.sourceEventId === f.sourceEventId && prev.bucket === f.bucket) continue
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

export function attentionItems(state: AttentionState): AttentionItem[] {
  return [...state.items.values()]
}

export function sortAttention(items: readonly AttentionItem[], _nowMs?: number): AttentionItem[] {
  return [...items].sort((a, b) => {
    if (a.urgency !== b.urgency) return a.urgency - b.urgency
    if (a.sinceMs !== b.sinceMs) return a.sinceMs - b.sinceMs
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0
  })
}

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
