
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

export interface InterviewOption {
  id: InterviewOptionId
  label: string
  description: string
  preview?: string
}

export interface InterviewQuestion {
  id: InterviewQuestionId
  decisionId: InterviewDecisionId
  text: string
  header: string
  options: InterviewOption[]
  multiSelect: boolean
  recommendedOptionId?: InterviewOptionId
}

export interface InterviewAnswerValue {
  optionIds: InterviewOptionId[]
  freeText?: string
}

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

export interface InterviewQuestionState {
  question: InterviewQuestion
  draft?: InterviewAnswerValue
  committed?: InterviewAnswerValue
  note?: string
  priorCommits: InterviewAnswerValue[]
}

export interface InterviewSessionState {
  schema: typeof INTERVIEW_SCHEMA_VERSION
  sessionId: InterviewSessionId | null
  mission: string
  toolUseId?: string
  phase: InterviewPhase
  round: number
  questionOrder: InterviewQuestionId[]
  questions: Record<InterviewQuestionId, InterviewQuestionState>
  context: InterviewContextRef[]
  contextScope: Record<string, InterviewQuestionId | undefined>
  focus: InterviewQuestionId | 'review' | null
  discussing: InterviewQuestionId | null
  outcome: InterviewOutcome | null
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

export function foldInterview(
  state: InterviewSessionState,
  event: InterviewEvent,
): InterviewSessionState {
  if (state.seenEventIds.has(event.eventId)) return state
  const seen = new Set(state.seenEventIds)
  seen.add(event.eventId)
  return applyEvent({ ...state, seenEventIds: seen }, event)
}

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

function applyEvent(s: InterviewSessionState, event: InterviewEvent): InterviewSessionState {
  switch (event.kind) {
    case 'session-opened': {
      if (s.sessionId !== null) return s
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
      return s
    }
  }
}

export function rebuildInterview(events: readonly InterviewEvent[]): InterviewSessionState {
  return rebuildInterviewFrom(emptyInterviewState(), events)
}

export function rebuildInterviewFrom(
  base: InterviewSessionState,
  events: readonly InterviewEvent[],
): InterviewSessionState {
  const seen = new Set(base.seenEventIds)
  let s: InterviewSessionState = { ...base, seenEventIds: seen }
  for (const e of events) s = foldInterviewShared(s, e, seen)
  return s
}
