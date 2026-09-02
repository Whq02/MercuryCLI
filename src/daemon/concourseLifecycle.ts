
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

export function decideTransition(
  from: ConcourseSessionState,
  to: ConcourseSessionState,
): TransitionDecision {
  if (from === to) return { legal: false, reason: 'idempotent-noop' }
  if (TERMINAL_STATES.has(from)) return { legal: false, reason: 'terminal-immutable' }
  if (!TRANSITIONS[from].includes(to)) return { legal: false, reason: 'illegal-transition' }
  return { legal: true, entryProof: ENTRY_PROOF_OF[to] }
}

export function isLiveState(s: ConcourseSessionState): boolean {
  return s === 'working' || s === 'needs-you' || s === 'stalled' || s === 'paused' || s === 'ready-to-review'
}

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
