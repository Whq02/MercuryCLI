// ============================================================================
//  concourseLifecycle —.4: the typed, TABLE-DRIVEN session
// lifecycle. Pure — no IO, no clock, no strings-in-UI: every
//  consumer (supervisor records, Concourse rows, /sessions projection,
//  notifications) speaks exactly this vocabulary, and every transition is a
//  table lookup, never an ad-hoc mutation.
//
// The law: entry only with the named proof class; "queued" never
//  renders as started; terminal states are IMMUTABLE — a retry/revision
//  mints a typed related successor identity, never a backward move; late or
//  duplicate events are idempotent (a self-transition is legal-but-noop
//  where listed).
// ============================================================================

export const CONCOURSE_SESSION_STATES = [
  'draft',
  'queued',
  'starting',
  'working',
  'needs-you',
  'stalled',
  'ready-to-review',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const

export type ConcourseSessionState = (typeof CONCOURSE_SESSION_STATES)[number]

export const TERMINAL_STATES: ReadonlySet<ConcourseSessionState> = new Set([
  'completed',
  'failed',
  'cancelled',
])

/** The table, verbatim: state → its ORDINARY exits. */
const TRANSITIONS: Readonly<Record<ConcourseSessionState, readonly ConcourseSessionState[]>> = {
  draft: ['queued', 'cancelled'],
  queued: ['starting', 'paused', 'cancelled', 'failed'],
  starting: ['working', 'stalled', 'failed', 'cancelled'],
  working: ['needs-you', 'stalled', 'ready-to-review', 'completed', 'failed', 'paused', 'cancelled'],
  'needs-you': ['working', 'paused', 'cancelled', 'failed'],
  stalled: ['queued', 'starting', 'working', 'failed', 'cancelled'],
  'ready-to-review': ['working', 'completed', 'cancelled'],
  paused: ['queued', 'starting', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/** The entry-proof classes — every transition RECEIPT names one. */
export type ConcourseEntryProof =
  | 'local-draft-identity'
  | 'durable-queue-receipt'
  | 'start-attempt-receipt'
  | 'worker-start-receipt'
  | 'attention-event'
  | 'typed-stall-reason'
  | 'evidence-receipt'
  | 'pause-settlement-receipt'
  | 'settlement-receipt'

export const ENTRY_PROOF_OF: Readonly<Record<ConcourseSessionState, ConcourseEntryProof>> = {
  draft: 'local-draft-identity',
  queued: 'durable-queue-receipt',
  starting: 'start-attempt-receipt',
  working: 'worker-start-receipt',
  'needs-you': 'attention-event',
  stalled: 'typed-stall-reason',
  'ready-to-review': 'evidence-receipt',
  paused: 'pause-settlement-receipt',
  completed: 'settlement-receipt',
  failed: 'settlement-receipt',
  cancelled: 'settlement-receipt',
}

export type TransitionDecision =
  | { legal: true; entryProof: ConcourseEntryProof }
  | { legal: false; reason: 'terminal-immutable' | 'illegal-transition' | 'idempotent-noop' }

/**
 * The ONE transition adjudicator. Duplicate/late deliveries of the current
 * state settle as idempotent no-ops (legal:false, reason 'idempotent-noop' —
 * the caller keeps its record untouched and re-acks the receipt); a terminal
 * state refuses EVERYTHING (immutable — successors are new identities); all
 * other moves consult the table.
 */
export function decideTransition(
  from: ConcourseSessionState,
  to: ConcourseSessionState,
): TransitionDecision {
  if (from === to) return { legal: false, reason: 'idempotent-noop' }
  if (TERMINAL_STATES.has(from)) return { legal: false, reason: 'terminal-immutable' }
  if (!TRANSITIONS[from].includes(to)) return { legal: false, reason: 'illegal-transition' }
  return { legal: true, entryProof: ENTRY_PROOF_OF[to] }
}

/** Count semantics: live = positively started, nonterminal, addressable.
 *  Queued/starting are NOT live (accepted-but-not-started); draft is local. */
export function isLiveState(s: ConcourseSessionState): boolean {
  return s === 'working' || s === 'needs-you' || s === 'stalled' || s === 'paused' || s === 'ready-to-review'
}

/** The attention-first board order (mirrors the crew inbox bucket
 *  order; the Concourse board groups by exactly this rank). */
export const BOARD_ORDER: readonly ConcourseSessionState[] = [
  'needs-you',
  'stalled',
  'ready-to-review',
  'working',
  'queued',
  'starting',
  'paused',
  'completed',
  'failed',
  'cancelled',
]

export function boardRank(s: ConcourseSessionState): number {
  const i = BOARD_ORDER.indexOf(s)
  return i === -1 ? BOARD_ORDER.length : i
}
