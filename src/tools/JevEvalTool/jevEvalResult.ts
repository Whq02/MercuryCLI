import {
  JEV_MAX_CALL_USD,
  type JevAnswer,
  type JevResponse,
  type JevStatus,
  type JevWireFailure,
  jevUsdLabel,
  jevWaitLabel,
} from '../../services/jev/jevContract.js'
import { jevStatusIsFinalForSession } from '../../services/jev/jevStatus.js'
import { JEV_EVAL_FULL_DISTRIBUTION_LIMIT, JEV_EVAL_LEVEL_LABEL_CLIP, JEV_EVAL_TIE_MARGIN } from './constants.js'

export const JEV_EVAL_NOUL_NOTE = '(noul carries no confidence)'
export const JEV_EVAL_FINAL_NOTICE = 'no further call will succeed this session for this reason; do not retry; carry on unaided'

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

export function jevEvalChoiceDistribution(probabilities: Record<string, number>): string {
  const entries = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  const top = entries[0]?.[1] ?? 0
  const shown =
    entries.length <= JEV_EVAL_FULL_DISTRIBUTION_LIMIT
      ? entries
      : entries.filter(([, p], index) => index < JEV_EVAL_FULL_DISTRIBUTION_LIMIT || p >= top - JEV_EVAL_TIE_MARGIN - 1e-9)
  const hidden = entries.length - shown.length
  const words = shown.map(([label, p]) => `${label} ${jevEvalProbability(p)}`).join('  ')
  return `{ ${words}${hidden > 0 ? `  +${hidden} more` : ''} }`
}

export function jevEvalAnswerLine(id: string, answer: JevAnswer): string {
  if (answer.type === 'noul') return `${id} noul p(yes) ${jevEvalProbability(answer.noul)} ${JEV_EVAL_NOUL_NOTE}`
  if (answer.type === 'choice') {
    return `${id} choice ${answer.choice} conf ${jevEvalProbability(answer.confidence)} ${jevEvalChoiceDistribution(answer.probabilities)}`
  }
  const indices = Object.keys(answer.legend)
    .map(Number)
    .filter(index => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b)
  const distribution = indices
    .map(index => {
      const p = answer.probabilities[String(index)]
      return `${index} ${p === undefined ? '?' : jevEvalProbability(p)}`
    })
    .join('  ')
  const levels = indices.map(index => `${index}=${clip(answer.legend[String(index)] ?? '', JEV_EVAL_LEVEL_LABEL_CLIP)}`).join(' ')
  return `${id} score ${jevEvalScore(answer.score)} of 0..${Math.max(0, indices.length - 1)} conf ${jevEvalProbability(answer.confidence)} { ${distribution} } levels: ${levels}`
}

export function jevEvalAnsweredText(response: JevResponse, chargeUsd: number, order: readonly string[]): string {
  const header = `JEV ${response.model} | in ${response.usage.input_tokens} tok | ${jevUsdLabel(chargeUsd)} | ok`
  const lines = order.filter(id => id in response.answers).map(id => jevEvalAnswerLine(id, response.answers[id]!))
  return [header, ...lines].join('\n')
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

export function jevEvalBadRequestText(failure: JevWireFailure): string {
  const status = failure.status !== undefined ? ` (${failure.status})` : ''
  return `JEV — | status=bad-request | the provider refused the request${status}: ${failure.detail} — fix the named field and call again; no answer arrived`
}

export function jevEvalFailureText(failure: JevWireFailure): string {
  const status = failure.status !== undefined ? `${failure.status} ` : ''
  return `JEV — | status=${failure.kind} | ${status}${failure.detail}`
}

export function jevEvalAbortedText(): string {
  return `JEV — | status=aborted | cancelled after the request was sent; no answer was read, the charge is unconfirmed and counted at the ${jevUsdLabel(JEV_MAX_CALL_USD)} ceiling; nothing was retried`
}
