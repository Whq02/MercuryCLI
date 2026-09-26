import {
  jevMaxRequestTokens,
  type JevRoad,
  JEV_MAX_STATE_PLUS_QUESTION_TOKENS,
  type JevQuestion,
  type JevRequest,
} from '../../services/jev/jevContract.js'
import {
  JEV_EVAL_BYTES_PER_TOKEN,
  JEV_EVAL_ESCAPE_MEANS,
  JEV_EVAL_ESCAPE_OPTION,
  JEV_EVAL_PARAGRAPH_FACT,
  JEV_EVAL_ROW_POSITION_PREFIX,
  JEV_EVAL_TOKENIZER_NOTE,
} from './constants.js'
import type { JevEvalEvidenceItem, JevEvalInput, JevEvalQuestion } from './jevEvalSchema.js'

export interface JevEvalEstimate {
  stateTokens: number
  questionTokens: Record<string, number>
  totalTokens: number
  longestId: string
  longestTokens: number
}

export interface JevEvalItem {
  label: string
  index: number
  state: Record<string, string>
}

export interface JevEvalItemRequest {
  item: JevEvalItem
  request: Pick<JevRequest, 'state' | 'questions'>
  estimate: JevEvalEstimate
}

export type JevEvalAssembly =
  | { ok: true; items: JevEvalItemRequest[]; questions: Record<string, JevQuestion>; order: string[] }
  | { ok: false; reason: string }

export function jevEvalTokenEstimate(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / JEV_EVAL_BYTES_PER_TOKEN)
}

export function jevEvalRowLabel(index: number): string {
  return `${JEV_EVAL_ROW_POSITION_PREFIX}${index + 1}`
}

export function jevEvalItems(evidence: readonly JevEvalEvidenceItem[]): JevEvalItem[] {
  return evidence.map((item, index) => {
    if (typeof item === 'string') return { label: jevEvalRowLabel(index), index, state: { [JEV_EVAL_PARAGRAPH_FACT]: item } }
    const { id, ...facts } = item
    return { label: id ?? jevEvalRowLabel(index), index, state: facts }
  })
}

export function jevEvalWireQuestion(question: JevEvalQuestion): JevQuestion {
  if (question.kind === 'noul') return { type: 'noul', instructions: question.ask }
  if (question.kind === 'choice') {
    const criteria: Record<string, string | null> = { ...(question.options ?? {}) }
    if (question.allow_none === true) criteria[JEV_EVAL_ESCAPE_OPTION] = question.none_means ?? JEV_EVAL_ESCAPE_MEANS
    return { type: 'choice', instructions: question.ask, criteria }
  }
  return { type: 'score', instructions: question.ask, criteria: [...(question.levels ?? [])] }
}

export function assembleJevEvalRequest(input: JevEvalInput, road: JevRoad = 'official'): JevEvalAssembly {
  const maxRequestTokens = jevMaxRequestTokens(road)
  const questions: Record<string, JevQuestion> = {}
  const order: string[] = []
  for (const question of input.questions) {
    questions[question.id] = jevEvalWireQuestion(question)
    order.push(question.id)
  }
  const questionTokens: Record<string, number> = {}
  let questionTotal = 0
  let longestId = order[0] ?? ''
  let longestTokens = -1
  for (const id of order) {
    const tokens = jevEvalTokenEstimate(JSON.stringify(questions[id]))
    questionTokens[id] = tokens
    questionTotal += tokens
    if (tokens > longestTokens) {
      longestTokens = tokens
      longestId = id
    }
  }
  const items: JevEvalItemRequest[] = []
  for (const item of jevEvalItems(input.evidence)) {
    const stateTokens = jevEvalTokenEstimate(JSON.stringify(item.state))
    const totalTokens = stateTokens + questionTotal
    const name = `evidence[${item.index}] (${item.label})`
    if (stateTokens + longestTokens > JEV_MAX_STATE_PLUS_QUESTION_TOKENS) {
      return {
        ok: false,
        reason: `${name} plus question "${longestId}" is about ${stateTokens + longestTokens} tokens (${JEV_EVAL_TOKENIZER_NOTE}); the provider takes at most ${JEV_MAX_STATE_PLUS_QUESTION_TOKENS} for one item's evidence plus the longest question — trim that item or shorten "${longestId}"; nothing was sent`,
      }
    }
    if (totalTokens > maxRequestTokens) {
      return {
        ok: false,
        reason: `${name} plus all ${order.length} questions is about ${totalTokens} tokens (${JEV_EVAL_TOKENIZER_NOTE}); the provider takes at most ${maxRequestTokens} a request — trim that item or drop questions (the longest is "${longestId}" at about ${longestTokens}); nothing was sent`,
      }
    }
    items.push({ item, request: { state: item.state, questions }, estimate: { stateTokens, questionTokens, totalTokens, longestId, longestTokens } })
  }
  return { ok: true, items, questions, order }
}
