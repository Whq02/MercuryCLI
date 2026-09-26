import {
  jevMaxCallUsd,
  type JevRoad,
  type JevAnswer,
  type JevResponse,
  type JevStatus,
  type JevWireFailure,
  jevUsdLabel,
  jevWaitLabel,
} from '../../services/jev/jevContract.js'
import { jevStatusIsFinalForSession } from '../../services/jev/jevStatus.js'
import { JEV_EVAL_CONFIDENCE_FLOOR, JEV_EVAL_LEVEL_LABEL_CLIP, JEV_EVAL_UNSURE } from './constants.js'
import type { JevEvalKind } from './jevEvalSchema.js'

export const JEV_EVAL_FINAL_NOTICE = 'no further call will succeed this session for this reason; do not retry; carry on unaided'

export type JevEvalRowOutcome =
  | { kind: 'pending' }
  | { kind: 'answered'; response: JevResponse; requestId?: string; chargeUsd: number }
  | { kind: 'failed'; failure: JevWireFailure }
  | { kind: 'not-sent'; status: JevStatus }

export interface JevEvalRow {
  label: string
  outcome: JevEvalRowOutcome
}

export interface JevEvalTable {
  rows: readonly JevEvalRow[]
  order: readonly string[]
  kinds: Readonly<Record<string, JevEvalKind>>
}

export function jevEvalProbability(value: number): string {
  const fixed = value.toFixed(2)
  return fixed.startsWith('0.') ? fixed.slice(1) : fixed
}

export function jevEvalScore(value: number): string {
  return String(Number(value.toFixed(2)))
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function levelIndices(answer: Extract<JevAnswer, { type: 'score' }>): number[] {
  return Object.keys(answer.legend)
    .map(Number)
    .filter(index => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b)
}

export function jevEvalUnsure(answer: JevAnswer, floor: number = JEV_EVAL_CONFIDENCE_FLOOR): boolean {
  if (answer.type === 'noul') return answer.noul >= 1 - floor - 1e-9 && answer.noul <= floor + 1e-9
  return answer.confidence < floor - 1e-9
}

function jevEvalNumbers(answer: JevAnswer): string {
  if (answer.type === 'noul') return jevEvalProbability(answer.noul)
  if (answer.type === 'choice') return `${answer.choice} ${jevEvalProbability(answer.probabilities[answer.choice] ?? 0)} conf ${jevEvalProbability(answer.confidence)}`
  return `${jevEvalScore(answer.score)} of 0..${Math.max(0, levelIndices(answer).length - 1)} conf ${jevEvalProbability(answer.confidence)}`
}

export function jevEvalCell(answer: JevAnswer, floor: number = JEV_EVAL_CONFIDENCE_FLOOR): string {
  const numbers = jevEvalNumbers(answer)
  return jevEvalUnsure(answer, floor) ? `${JEV_EVAL_UNSURE} · ${numbers}` : numbers
}

export function jevEvalFailureEvidence(failure: JevWireFailure): string {
  const status = failure.status !== undefined ? `HTTP ${failure.status}: ` : ''
  return `${status}${failure.detail}${failure.requestId ? ` | id=${failure.requestId}` : ''}`
}

export function jevEvalRowLine(row: JevEvalRow, order: readonly string[]): string {
  const outcome = row.outcome
  if (outcome.kind === 'answered') return `${row.label} | ${order.map(id => (id in outcome.response.answers ? jevEvalCell(outcome.response.answers[id]!) : '?')).join(' | ')}`
  if (outcome.kind === 'failed') return `${row.label} | unavailable — ${outcome.failure.kind} — ${jevEvalFailureEvidence(outcome.failure)}`
  if (outcome.kind === 'not-sent') return `${row.label} | not sent — ${outcome.status.words}`
  return `${row.label} | unavailable — no answer was read`
}

export function jevEvalLegendLines(table: JevEvalTable): string[] {
  const first = table.rows.find(row => row.outcome.kind === 'answered')
  if (first === undefined || first.outcome.kind !== 'answered') return []
  const lines: string[] = []
  for (const id of table.order) {
    const answer = first.outcome.response.answers[id]
    if (answer?.type !== 'score') continue
    lines.push(`${id} levels: ${levelIndices(answer).map(index => `${index}=${clip(answer.legend[String(index)] ?? '', JEV_EVAL_LEVEL_LABEL_CLIP)}`).join(' ')}`)
  }
  return lines
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

export function jevEvalStatedUsd(answered: ReadonlyArray<Extract<JevEvalRowOutcome, { kind: 'answered' }>>): number | undefined {
  if (answered.length === 0 || answered.some(outcome => outcome.response.usage.cost === undefined)) return undefined
  if (answered.length === 1) return answered[0]!.response.usage.cost
  return Number(answered.reduce((sum, outcome) => sum + (outcome.response.usage.cost ?? 0), 0).toFixed(8))
}

export function jevEvalTableText(table: JevEvalTable): string {
  const answered = table.rows.flatMap(row => (row.outcome.kind === 'answered' ? [row.outcome] : []))
  const model = answered[0]?.response.model ?? '—'
  const inputTokens = answered.reduce((sum, outcome) => sum + outcome.response.usage.input_tokens, 0)
  const charge = answered.reduce((sum, outcome) => sum + outcome.chargeUsd, 0)
  const stated = jevEvalStatedUsd(answered)
  const requestId = answered.length === 1 ? answered[0]!.requestId : undefined
  const verdict = answered.length === table.rows.length ? 'ok' : `ok ${answered.length} of ${table.rows.length}`
  const header = `JEV ${model} | ${count(table.rows.length, 'item')} × ${count(table.order.length, 'question')} | in ${inputTokens} tok | ${jevUsdLabel(charge)}${stated !== undefined ? ` | stated $${stated}` : ''}${requestId ? ` | id=${requestId}` : ''} | floor ${JEV_EVAL_CONFIDENCE_FLOOR} | ${verdict}`
  const columns = `item | ${table.order.map(id => `${id} (${table.kinds[id] ?? '?'})`).join(' | ')}`
  return [header, columns, ...table.rows.map(row => jevEvalRowLine(row, table.order)), ...jevEvalLegendLines(table)].join('\n')
}

export function jevEvalNoticeSentence(status: JevStatus): string {
  if (jevStatusIsFinalForSession(status.kind)) return JEV_EVAL_FINAL_NOTICE
  if (status.retryInMs !== undefined) return `the next attempt is admitted in ${jevWaitLabel(status.retryInMs)}; do not retry before then`
  return 'do not retry until /jev reads ready'
}

export function jevEvalUnavailableText(status: JevStatus, notice: boolean): string {
  const first = `JEV — | status=${status.kind} | ${status.words}`
  return notice ? `${first}\nnotice: ${jevEvalNoticeSentence(status)}` : first
}

export function jevEvalRefusedText(reason: string): string {
  return `JEV — | status=refused | ${reason}`
}

export function jevEvalUnansweredCount(rows: number): string {
  return rows > 1 ? ` | 0 of ${rows} items answered` : ''
}

export function jevEvalBadRequestText(failure: JevWireFailure): string {
  const status = failure.status !== undefined ? ` (${failure.status})` : ''
  return `JEV — | status=bad-request | the provider refused the request${status}: ${failure.detail}${failure.requestId ? ` | id=${failure.requestId}` : ''} — fix the named field and call again; no answer arrived`
}

export function jevEvalFailureText(failure: JevWireFailure): string {
  const status = failure.status !== undefined ? `${failure.status} ` : ''
  return `JEV — | status=${failure.kind} | ${status}${failure.detail}${failure.requestId ? ` | id=${failure.requestId}` : ''}`
}

export function jevEvalAbortedText(road: JevRoad = 'official', sent = 1, rows = 1): string {
  const ceiling = jevUsdLabel(jevMaxCallUsd(road))
  if (rows <= 1) return `JEV — | status=aborted | cancelled after the request was sent; no answer was read, the charge is unconfirmed and counted at the ${ceiling} ceiling; nothing was retried`
  return `JEV — | status=aborted | cancelled after ${sent} of ${rows} requests were sent; no answer was read, each charge is unconfirmed and counted at the ${ceiling} ceiling; nothing was retried`
}
