import {
  JEV_MAX_REQUEST_TOKENS,
  JEV_MAX_STATE_PLUS_QUESTION_TOKENS,
  type JevQuestion,
  type JevRequest,
} from '../../services/jev/jevContract.js'
import { JEV_EVAL_BYTES_PER_TOKEN, JEV_EVAL_ESCAPE_MEANS, JEV_EVAL_ESCAPE_OPTION, JEV_EVAL_TOKENIZER_NOTE } from './constants.js'
import type { JevEvalInput, JevEvalQuestion } from './jevEvalSchema.js'

export interface JevEvalEstimate {
  stateTokens: number
  questionTokens: Record<string, number>
  totalTokens: number
  longestId: string
  longestTokens: number
}

export type JevEvalAssembly =
  | { ok: true; request: Pick<JevRequest, 'state' | 'questions'>; order: string[]; estimate: JevEvalEstimate }
  | { ok: false; reason: string; estimate: JevEvalEstimate }

export function jevEvalTokenEstimate(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / JEV_EVAL_BYTES_PER_TOKEN)
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

export function assembleJevEvalRequest(input: JevEvalInput): JevEvalAssembly {
  const questions: Record<string, JevQuestion> = {}
  const order: string[] = []
  for (const question of input.questions) {
    questions[question.id] = jevEvalWireQuestion(question)
    order.push(question.id)
  }
  const stateTokens = jevEvalTokenEstimate(JSON.stringify(input.evidence))
  const questionTokens: Record<string, number> = {}
  let totalTokens = stateTokens
  let longestId = order[0] ?? ''
  let longestTokens = -1
  for (const id of order) {
    const tokens = jevEvalTokenEstimate(JSON.stringify(questions[id]))
    questionTokens[id] = tokens
    totalTokens += tokens
    if (tokens > longestTokens) {
      longestTokens = tokens
      longestId = id
    }
  }
  const estimate: JevEvalEstimate = { stateTokens, questionTokens, totalTokens, longestId, longestTokens }
  if (stateTokens + longestTokens > JEV_MAX_STATE_PLUS_QUESTION_TOKENS) {
    return {
      ok: false,
      reason: `evidence plus question "${longestId}" is about ${stateTokens + longestTokens} tokens (${JEV_EVAL_TOKENIZER_NOTE}); the provider takes at most ${JEV_MAX_STATE_PLUS_QUESTION_TOKENS} for the evidence plus the longest question — trim the evidence or shorten "${longestId}"; nothing was sent`,
      estimate,
    }
  }
  if (totalTokens > JEV_MAX_REQUEST_TOKENS) {
    return {
      ok: false,
      reason: `evidence plus all ${order.length} questions is about ${totalTokens} tokens (${JEV_EVAL_TOKENIZER_NOTE}); the provider takes at most ${JEV_MAX_REQUEST_TOKENS} a request — trim the evidence or drop questions (the longest is "${longestId}" at about ${longestTokens}); nothing was sent`,
      estimate,
    }
  }
  return { ok: true, request: { state: input.evidence, questions }, order, estimate }
}
