export const JEV_BASE_URL = 'https://api.typesafe.ai'
export const JEV_BASE_URL_ENV = 'MERCURY_JEV_BASE'
export const JEV_SYSTEMONE_PATH = '/v1/systemone'
export const JEV_MODEL_PIN = 'jev-1.13.0'
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1_000_000
export const JEV_MAX_REQUEST_TOKENS = 64_000
export const JEV_MAX_STATE_PLUS_QUESTION_TOKENS = 32_000
export const JEV_MAX_CALL_USD = JEV_MAX_REQUEST_TOKENS * JEV_USD_PER_INPUT_TOKEN
export const JEV_MAX_CHOICE_OPTIONS = 255
export const JEV_MIN_SCORE_LEVELS = 2
export const JEV_MAX_SCORE_LEVELS = 10
export const JEV_TIMEOUT_MS = 10_000
export const JEV_SUBAGENT_CALL_BUDGET = 2
export const JEV_TOOL_NAME = 'JevEval'
export const JEV_PROVIDER_NAME = 'TypeSafe'

export type JevText = string | Record<string, unknown> | readonly unknown[]
export type JevState = JevText

export interface JevNoulQuestion {
  type: 'noul'
  instructions: JevText
  criteria?: { true?: JevText | null; false?: JevText | null }
}

export interface JevChoiceQuestion {
  type: 'choice'
  instructions: JevText
  criteria: Record<string, JevText | null>
}

export interface JevScoreQuestion {
  type: 'score'
  instructions: JevText
  criteria: readonly JevText[]
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion
export type JevQuestionType = JevQuestion['type']

export interface JevRequest {
  model: string
  state: JevState
  questions: Record<string, JevQuestion>
}

export interface JevNoulAnswer {
  type: 'noul'
  noul: number
}

export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

export interface JevScoreAnswer {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer

export interface JevUsage {
  input_tokens: number
  output_tokens: number
}

export interface JevResponse {
  model: string
  answers: Record<string, JevAnswer>
  usage: JevUsage
}

export type JevWireFailureKind =
  | 'invalid-key'
  | 'bad-request'
  | 'rate-limited'
  | 'provider-down'
  | 'provider-refused'
  | 'parse-failed'
  | 'aborted'

export interface JevWireFailure {
  kind: JevWireFailureKind
  status?: number
  detail: string
  retryAfterMs?: number
  requestId?: string
}

export type JevWireOutcome = { ok: true; response: JevResponse; requestId?: string } | { ok: false; failure: JevWireFailure }

export type JevLocalRefusalKind = 'allowance-hit' | 'pace-hit' | 'ceiling-hit' | 'subagent-budget-hit'

export type JevStatusKind =
  | 'ready'
  | 'off'
  | 'no-key'
  | 'invalid-key'
  | JevLocalRefusalKind
  | 'rate-limited'
  | 'provider-down'
  | 'provider-credit'
  | 'provider-refused'

export const JEV_STATUS_KINDS: readonly JevStatusKind[] = [
  'ready',
  'off',
  'no-key',
  'invalid-key',
  'allowance-hit',
  'pace-hit',
  'ceiling-hit',
  'subagent-budget-hit',
  'rate-limited',
  'provider-down',
  'provider-credit',
  'provider-refused',
]

export interface JevStatus {
  kind: JevStatusKind
  words: string
  retryInMs?: number
}

export function jevChargeUsd(inputTokens: number): number {
  return Math.max(0, inputTokens) * JEV_USD_PER_INPUT_TOKEN
}

export function jevWireFailureKindForStatus(status: number): JevWireFailureKind {
  if (status === 401 || status === 403) return 'invalid-key'
  if (status === 400 || status === 422) return 'bad-request'
  if (status === 429) return 'rate-limited'
  if (status === 529 || status >= 500) return 'provider-down'
  return 'provider-refused'
}

const CREDIT_WORDS = /\b(credit|credits|balance|funds|insufficient|top[- ]?up|billing|quota exceeded|payment)\b/i

export function jevRefusalNamesCredit(detail: string): boolean {
  return CREDIT_WORDS.test(detail)
}

export function jevWaitLabel(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

export function jevClockLabel(at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function jevUsdLabel(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return `$${usd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${usd.toFixed(2)}`
}
