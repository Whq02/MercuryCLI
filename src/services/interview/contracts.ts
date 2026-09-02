/**
 * MERCURY INTERVIEW contracts — the typed vocabulary and the PURE fold of
 * the ONE versioned interview-session authority.
 *
 * IDENTITY LAW (binding):
 *   - Question text is DISPLAY CONTENT, not identity. Every question, option,
 *     decision, session, and record carries a stable ID; rewording a question
 *     re-uses its declared ID and never orphans answers, notes, context, or
 *     history. Identity is DECLARED (by the asking side or minted once at
 *     presentation), never inferred from text similarity — a false join is
 *     worse than a fresh decision.
 *   - Typed outcomes: discussion is discussion, finishing is finishing,
 *     cancellation is cancellation, submission is submission. No outcome is
 *     encoded as prose feedback on a rejection (the inherited overloads the
 *     Wave A adapter retires).
 *
 * FOLD LAWS (proved by scripts/interview/prove-session-fold.ts):
 *   pure + I/O-free · idempotent replay (event ids dedupe) · rebuilt ≡
 *   live-incremental · reword preserves identity · revision preserves
 *   unaffected decisions · serialization round-trips byte-stably.
 *
 * The incremental store (subscribers, persistence, stable-reference
 * snapshots) lives beside this file in store.ts — this module stays pure.
 * Cross-process readers serialize a pure fold over the request's own
 * snapshot; nothing arms a store in a bridge process.
 */

/** Versioned schema — bump only with a decoder for every prior version. */
export const INTERVIEW_SCHEMA_VERSION = 1

export type InterviewSessionId = string
export type InterviewDecisionId = string
export type InterviewQuestionId = string
export type InterviewOptionId = string
export type InterviewEventId = string

export const INTERVIEW_PHASES = [
  'preparing',
  'asking',
  'discussing',
  'reviewing',
  'completed',
  'cancelled',
] as const
export type InterviewPhase = (typeof INTERVIEW_PHASES)[number]

/** One presented option — identity + display copy + optional preview. */
export interface InterviewOption {
  id: InterviewOptionId
  label: string
  description: string
  preview?: string
}

/** One presented question. `decisionId` is the durable subject the question
 *  serves — re-asking or rewording the same decision keeps the SAME
 *  decisionId (and normally the same questionId); a fresh round about a new
 *  subject mints fresh ids. */
export interface InterviewQuestion {
  id: InterviewQuestionId
  decisionId: InterviewDecisionId
  text: string
  header: string
  options: InterviewOption[]
  multiSelect: boolean
  /** The asking side's honest recommendation, when evidence supports one. */
  recommendedOptionId?: InterviewOptionId
}

/** A committed or drafted answer — option identities, never display text.
 *  Free text rides `freeText` (the Other route); both may be present. */
export interface InterviewAnswerValue {
  optionIds: InterviewOptionId[]
  freeText?: string
}

/** A context reference — the shelf owns bodies; the interview stores stable
 *  references + lightweight metadata only. */
export interface InterviewContextRef {
  refId: string
  kind: 'file' | 'image' | 'selection' | 'large-paste' | 'artifact' | 'session-ref'
  label: string
}

export type InterviewOutcome =
  | { kind: 'answers-submitted'; decisionRecordId: string }
  | { kind: 'discussion-requested'; questionId: InterviewQuestionId }
  | { kind: 'finish-requested'; retainedDecisionIds: InterviewDecisionId[] }
  | { kind: 'cancelled'; preserveDraft: boolean }

/** The event vocabulary. Every event carries a session-unique `eventId`
 *  (idempotency key) and `atMs` (wall stamp — display only, never a fold
 *  transition input: time moves NOTHING in this fold). */
export type InterviewEvent =
  | {
      kind: 'session-opened'
      eventId: InterviewEventId
      atMs: number
      sessionId: InterviewSessionId
      mission: string
      toolUseId?: string
    }
  | {
      kind: 'questions-presented'
      eventId: InterviewEventId
      atMs: number
      questions: InterviewQuestion[]
      /** The presentation round (1-based). Re-presenting a known questionId
       *  updates display copy in place — identity holds. */
      round: number
    }
  | {
      kind: 'answer-drafted'
      eventId: InterviewEventId
      atMs: number
      questionId: InterviewQuestionId
      value: InterviewAnswerValue
    }
  | {
      kind: 'answer-committed'
      eventId: InterviewEventId
      atMs: number
      questionId: InterviewQuestionId
      value: InterviewAnswerValue
    }
  | {
      kind: 'note-set'
      eventId: InterviewEventId
      atMs: number
      questionId: InterviewQuestionId
      note: string
    }
  | {
      kind: 'context-attached'
      eventId: InterviewEventId
      atMs: number
      ref: InterviewContextRef
      /** Absent scope = interview-wide (the operator marked it so). */
      questionId?: InterviewQuestionId
    }
  | {
      kind: 'context-detached'
      eventId: InterviewEventId
      atMs: number
      refId: string
    }
  | {
      kind: 'navigated'
      eventId: InterviewEventId
      atMs: number
      /** The focused question, or 'review'. */
      target: InterviewQuestionId | 'review'
    }
  | {
      kind: 'discussion-opened'
      eventId: InterviewEventId
      atMs: number
      questionId: InterviewQuestionId
    }
  | {
      kind: 'discussion-returned'
      eventId: InterviewEventId
      atMs: number
      questionId: InterviewQuestionId
      /** A discussion proposes; it never silently answers (law C1). */
      proposedValue?: InterviewAnswerValue
    }
  | {
      kind: 'finish-requested'
      eventId: InterviewEventId
      atMs: number
      retainedDecisionIds: InterviewDecisionId[]
    }
  | {
      kind: 'submitted'
      eventId: InterviewEventId
      atMs: number
      decisionRecordId: string
    }
  | {
      kind: 'cancelled'
      eventId: InterviewEventId
      atMs: number
      preserveDraft: boolean
    }

/** Per-question folded state. */
export interface InterviewQuestionState {
  question: InterviewQuestion
  draft?: InterviewAnswerValue
  committed?: InterviewAnswerValue
  note?: string
  /** Committed values superseded by later commits, oldest first. */
  priorCommits: InterviewAnswerValue[]
}

export interface InterviewSessionState {
  schema: typeof INTERVIEW_SCHEMA_VERSION
  sessionId: InterviewSessionId | null
  mission: string
  toolUseId?: string
  phase: InterviewPhase
  round: number
  /** Presentation order of question ids (stable across rewords). */
  questionOrder: InterviewQuestionId[]
  questions: Record<InterviewQuestionId, InterviewQuestionState>
  context: InterviewContextRef[]
  /** refId → questionId; absent = interview-wide. */
  contextScope: Record<string, InterviewQuestionId | undefined>
  focus: InterviewQuestionId | 'review' | null
  /** The question under discussion while phase === 'discussing'. */
  discussing: InterviewQuestionId | null
  outcome: InterviewOutcome | null
  /** Every folded eventId — the idempotency receipt. A Set since
   *  (near-O(1) dedupe); no consumer reads it semantically — the fold
   *  is the only reader. JSON-serializing a STATE drops it ({}), which is
   *  fine: states are never durable — the event log is. */
  seenEventIds: ReadonlySet<string>
}

export function emptyInterviewState(): InterviewSessionState {
  return {
    schema: INTERVIEW_SCHEMA_VERSION,
    sessionId: null,
    mission: '',
    phase: 'preparing',
    round: 0,
    questionOrder: [],
    questions: {},
    context: [],
    contextScope: {},
    focus: null,
    discussing: null,
    outcome: null,
    seenEventIds: new Set(),
  }
}

/** THE pure fold. Unknown event ids replay as no-ops (idempotency); an event
 *  for an unknown question is a bounded no-op, never a throw — malformed
 *  input produces a clear bounded result. Dedupe is
 *  near-O(1) (`Set.has`); this PURE arm copies the receipt set per folded
 *  event (safe for arbitrary external callers), while the shared-set arm
 *  below gives the rebuild loop and the live store O(n)-total folding
 * */
export function foldInterview(
  state: InterviewSessionState,
  event: InterviewEvent,
): InterviewSessionState {
  if (state.seenEventIds.has(event.eventId)) return state
  const seen = new Set(state.seenEventIds)
  seen.add(event.eventId)
  return applyEvent({ ...state, seenEventIds: seen }, event)
}

/** The shared-set fold arm: `seen` is OWNED AND MUTATED by the
 *  caller (the rebuild loop / the live store), so folding a whole log does
 *  O(1) dedupe work per event — O(n) TOTAL — instead of an O(n) receipt copy
 *  per event. Returned states ALIAS `seen` (a live-updating receipt; no
 *  consumer reads it semantically — the fold is the only reader). */
export function foldInterviewShared(
  state: InterviewSessionState,
  event: InterviewEvent,
  seen: Set<string>,
): InterviewSessionState {
  if (seen.has(event.eventId)) return state
  seen.add(event.eventId)
  return applyEvent(
    state.seenEventIds === seen ? { ...state } : { ...state, seenEventIds: seen },
    event,
  )
}

/** The event transition body shared by both fold arms (dedupe already
 *  applied; `s` carries the updated receipt set). */
function applyEvent(s: InterviewSessionState, event: InterviewEvent): InterviewSessionState {
  switch (event.kind) {
    case 'session-opened': {
      if (s.sessionId !== null) return s // one opening; replays no-op
      return {
        ...s,
        sessionId: event.sessionId,
        mission: event.mission,
        toolUseId: event.toolUseId,
        phase: 'asking',
      }
    }
    case 'questions-presented': {
      const order = [...s.questionOrder]
      const questions = { ...s.questions }
      for (const q of event.questions) {
        const known = questions[q.id]
        if (known) {
          // Reword/re-present: display copy moves, identity + answers stay.
          questions[q.id] = { ...known, question: q }
        } else {
          questions[q.id] = { question: q, priorCommits: [] }
          order.push(q.id)
        }
      }
      const focus = s.focus ?? event.questions[0]?.id ?? null
      return { ...s, round: Math.max(s.round, event.round), questionOrder: order, questions, focus }
    }
    case 'answer-drafted': {
      const qs = s.questions[event.questionId]
      if (!qs) return s
      return {
        ...s,
        questions: { ...s.questions, [event.questionId]: { ...qs, draft: event.value } },
      }
    }
    case 'answer-committed': {
      const qs = s.questions[event.questionId]
      if (!qs) return s
      const priorCommits = qs.committed ? [...qs.priorCommits, qs.committed] : qs.priorCommits
      return {
        ...s,
        questions: {
          ...s.questions,
          [event.questionId]: { ...qs, committed: event.value, draft: undefined, priorCommits },
        },
      }
    }
    case 'note-set': {
      const qs = s.questions[event.questionId]
      if (!qs) return s
      return {
        ...s,
        questions: { ...s.questions, [event.questionId]: { ...qs, note: event.note } },
      }
    }
    case 'context-attached': {
      if (s.context.some(c => c.refId === event.ref.refId)) return s
      return {
        ...s,
        context: [...s.context, event.ref],
        contextScope: { ...s.contextScope, [event.ref.refId]: event.questionId },
      }
    }
    case 'context-detached': {
      if (!s.context.some(c => c.refId === event.refId)) return s
      const contextScope = { ...s.contextScope }
      delete contextScope[event.refId]
      return { ...s, context: s.context.filter(c => c.refId !== event.refId), contextScope }
    }
    case 'navigated': {
      if (event.target !== 'review' && !s.questions[event.target]) return s
      return { ...s, focus: event.target, phase: event.target === 'review' ? 'reviewing' : 'asking' }
    }
    case 'discussion-opened': {
      if (!s.questions[event.questionId]) return s
      return { ...s, phase: 'discussing', discussing: event.questionId }
    }
    case 'discussion-returned': {
      if (s.discussing !== event.questionId) return s
      const qs = s.questions[event.questionId]
      const questions =
        event.proposedValue && qs
          ? { ...s.questions, [event.questionId]: { ...qs, draft: event.proposedValue } }
          : s.questions
      return { ...s, phase: 'asking', discussing: null, focus: event.questionId, questions }
    }
    case 'finish-requested': {
      return {
        ...s,
        phase: 'completed',
        outcome: { kind: 'finish-requested', retainedDecisionIds: event.retainedDecisionIds },
      }
    }
    case 'submitted': {
      return {
        ...s,
        phase: 'completed',
        outcome: { kind: 'answers-submitted', decisionRecordId: event.decisionRecordId },
      }
    }
    case 'cancelled': {
      return {
        ...s,
        phase: 'cancelled',
        outcome: { kind: 'cancelled', preserveDraft: event.preserveDraft },
      }
    }
    default: {
      // A kind this build does not know (a newer writer's log, a corrupted
      // row) replays as a BOUNDED no-op — recorded in the ledger, moving
      // nothing. Without this arm the switch falls through to undefined and
      // one foreign row would poison the whole rebuild (law D2).
      return s
    }
  }
}

/** Rebuild from scratch — the live≡rebuild law's reference implementation.
 *  Linear in the events. */
export function rebuildInterview(events: readonly InterviewEvent[]): InterviewSessionState {
  return rebuildInterviewFrom(emptyInterviewState(), events)
}

/** Rebuild continuing FROM a base state.
 *  The base's receipt set is cloned ONCE and shared across the whole fold. */
export function rebuildInterviewFrom(
  base: InterviewSessionState,
  events: readonly InterviewEvent[],
): InterviewSessionState {
  const seen = new Set(base.seenEventIds)
  let s: InterviewSessionState = { ...base, seenEventIds: seen }
  for (const e of events) s = foldInterviewShared(s, e, seen)
  return s
}
