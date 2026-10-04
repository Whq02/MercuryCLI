
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { getCwd } from '../../utils/cwd.js'
import { logError } from '../../utils/log.js'
import type {
  InterviewEvent,
  InterviewSessionState,
} from './contracts.js'

export const DECISION_RECORD_SCHEMA = 1

export interface DecisionEntry {
  decisionId: string
  questionId: string
  question: string
  header: string
  selected: { optionIds: string[]; labels: string[]; freeText?: string }
  notes?: string
  declined: { optionId: string; label: string }[]
  contextRefIds: string[]
  provenance: { committedEventIds: string[] }
}

export interface InterviewDecisionRecord {
  schema: typeof DECISION_RECORD_SCHEMA
  recordId: string
  sessionId: string
  mission: string
  createdAtMs: number
  decisions: DecisionEntry[]
  unresolved: string[]
}

export function buildDecisionRecord(
  state: InterviewSessionState,
  events: readonly InterviewEvent[],
  recordId: string,
  createdAtMs: number,
): InterviewDecisionRecord {
  const decisions: DecisionEntry[] = []
  const unresolved: string[] = []
  for (const qid of state.questionOrder) {
    const qs = state.questions[qid]
    if (!qs) continue
    const q = qs.question
    if (!qs.committed) {
      unresolved.push(q.decisionId)
      continue
    }
    const selectedIds = new Set(qs.committed.optionIds)
    decisions.push({
      decisionId: q.decisionId,
      questionId: q.id,
      question: q.text,
      header: q.header,
      selected: {
        optionIds: qs.committed.optionIds,
        labels: qs.committed.optionIds
          .map(id => q.options.find(o => o.id === id)?.label)
          .filter((l): l is string => !!l),
        ...(qs.committed.freeText ? { freeText: qs.committed.freeText } : {}),
      },
      ...(qs.note?.trim() ? { notes: qs.note.trim() } : {}),
      declined: q.options
        .filter(o => !selectedIds.has(o.id))
        .map(o => ({ optionId: o.id, label: o.label })),
      contextRefIds: state.context
        .filter(c => {
          const scope = state.contextScope[c.refId]
          return scope === undefined || scope === q.id
        })
        .map(c => c.refId),
      provenance: {
        committedEventIds: events
          .filter(e => e.kind === 'answer-committed' && e.questionId === q.id)
          .map(e => e.eventId),
      },
    })
  }
  return {
    schema: DECISION_RECORD_SCHEMA,
    recordId,
    sessionId: state.sessionId ?? '',
    mission: state.mission,
    createdAtMs,
    decisions,
    unresolved,
  }
}


function projectKey(): string {
  return createHash('sha256').update(getCwd()).digest('hex').slice(0, 16)
}

function recordPath(): string {
  return join(getMercuryHome(), 'interview', `${projectKey()}-record.json`)
}

export function persistDecisionRecord(record: InterviewDecisionRecord): void {
  try {
    durableAtomicPublishSync(recordPath(), JSON.stringify(record, null, 1))
  } catch (e) {
    logError(`interview decision-record persist failed: ${e}`)
  }
}

export function latestDecisionRecordSync(): InterviewDecisionRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(), 'utf8')) as InterviewDecisionRecord
    if (parsed?.schema !== DECISION_RECORD_SCHEMA || !Array.isArray(parsed.decisions)) return null
    return parsed
  } catch {
    return null
  }
}
