import { flagEnv } from '../../substrate/flagRegistry.js'
import { retryAfterOf } from './retryAfter.js'

export const RECOVERY_BUDGET_DEFAULT_MINUTES = 5

export function recoveryBudgetMs(): number {
  const raw = flagEnv('MERCURY_RECOVERY_BUDGET_MINUTES')
  if (raw === undefined || raw.trim() === '') return RECOVERY_BUDGET_DEFAULT_MINUTES * 60_000
  const minutes = Number.parseFloat(raw)
  if (!Number.isFinite(minutes) || minutes < 0) return RECOVERY_BUDGET_DEFAULT_MINUTES * 60_000
  return minutes === 0 ? Infinity : minutes * 60_000
}

export interface RecoveryBudget {
  capMs: number
  spentMs: number
  waits: number
  lastStatus: number | undefined
  lastCause: string | undefined
}

export function makeRecoveryBudget(capMs: number = recoveryBudgetMs()): RecoveryBudget {
  return { capMs, spentMs: 0, waits: 0, lastStatus: undefined, lastCause: undefined }
}

export function recoveryBudgetRemainingMs(budget: RecoveryBudget): number {
  return budget.capMs === Infinity ? Infinity : Math.max(0, budget.capMs - budget.spentMs)
}

export function refillRecoveryBudget(budget: RecoveryBudget): void {
  budget.spentMs = 0
  budget.waits = 0
  budget.lastStatus = undefined
  budget.lastCause = undefined
}

export function recoveryAnswerRefills(message: unknown): boolean {
  const m = message as { type?: string; event?: { type?: string }; isApiErrorMessage?: boolean } | null
  if (!m) return false
  if (m.type === 'stream_event') return m.event?.type === 'message_start'
  if (m.type === 'assistant') return m.isApiErrorMessage !== true
  return false
}

export function chargeRecoveryWait(
  budget: RecoveryBudget,
  declaredMs: number,
  status?: number,
  cause?: string,
): { honoredMs: number; spent: boolean } {
  const declared = Number.isFinite(declaredMs) && declaredMs > 0 ? declaredMs : 0
  const remaining = recoveryBudgetRemainingMs(budget)
  const honoredMs = Math.min(declared, remaining)
  budget.spentMs += honoredMs
  budget.waits += 1
  if (status !== undefined) budget.lastStatus = status
  if (cause !== undefined) budget.lastCause = cause
  return { honoredMs, spent: recoveryBudgetRemainingMs(budget) <= 0 }
}

export type RecoveryWaitClass = 'throttle' | 'fault' | 'recovery'

export interface RecoveryNoticeFacts {
  declaredMs: number
  attempt: number | undefined
  of: number | undefined
  status: number | undefined
  kind: RecoveryWaitClass
  providerDeclared: boolean
  cause: string
  message: string
}

export function honourRecoveryWait(
  budget: RecoveryBudget,
  facts: RecoveryNoticeFacts,
): { honoredMs: number; spent: boolean; charged: boolean } {
  if (facts.kind !== 'throttle') return { honoredMs: facts.declaredMs, spent: false, charged: false }
  const { honoredMs, spent } = chargeRecoveryWait(budget, facts.declaredMs, facts.status, facts.cause)
  return { honoredMs, spent, charged: true }
}

export function retrySeconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest === 0 ? `${m}m` : `${m}m ${rest}s`
}

export function recoveryBudgetWords(budget: RecoveryBudget): string {
  return budget.capMs === Infinity ? 'no retry budget' : `${retrySeconds(budget.capMs).replace(/ s$/, 's')} retry budget`
}

const OVERLOADED_MARKER = '"type":"overloaded_error"'

function causeWords(kind: RecoveryWaitClass, status: number | undefined, message: string): string {
  if (kind === 'throttle') {
    if (status === 429) return 'provider busy (HTTP 429)'
    if (status === 529 || message.includes(OVERLOADED_MARKER)) return 'provider overloaded (HTTP 529)'
    return status !== undefined ? `provider asked for a wait (HTTP ${status})` : 'provider asked for a wait'
  }
  if (kind === 'recovery') {
    if (status === 404) return 'the streaming door refused (HTTP 404)'
    return /watchdog|no stream events|went quiet|silen/i.test(message) ? 'the stream went quiet' : 'the stream dropped'
  }
  if (status === 408) return 'the request timed out (HTTP 408)'
  if (status === 409) return 'provider conflict (HTTP 409)'
  if (status === 401 || status === 403) return `the sign-in is refreshing (HTTP ${status})`
  if (status !== undefined && status >= 500) return `provider error (HTTP ${status})`
  if (status !== undefined) return `provider answered HTTP ${status}`
  return /no first byte/.test(message) ? 'no first byte' : 'connection lost'
}

export function retryWaitWords(args: { facts: RecoveryNoticeFacts; honoredMs: number; budget: RecoveryBudget }): string {
  const { facts, honoredMs, budget } = args
  const ladder = `retry ${facts.attempt ?? budget.waits}${facts.of !== undefined && facts.of > 0 ? ` of ${facts.of}` : ''}`
  if (facts.kind === 'recovery') {
    const action = /reissu/i.test(facts.message) ? 'reissuing the stream' : 'one non-streamed answer'
    return `${facts.cause} — ${action}, up to ${retrySeconds(facts.declaredMs)}`
  }
  if (facts.kind === 'fault') return `${facts.cause} — waiting ${retrySeconds(facts.declaredMs)} before ${ladder}`
  const words = recoveryBudgetWords(budget)
  if (honoredMs < facts.declaredMs) {
    const ask = facts.providerDeclared ? `the provider asked for ${retrySeconds(facts.declaredMs)}` : `waiting ${retrySeconds(facts.declaredMs)} before ${ladder}`
    return `${facts.cause} — ${ask}; the ${words} ends this wait after ${retrySeconds(honoredMs)}`
  }
  const head = `${facts.cause} — waiting ${retrySeconds(honoredMs)} before ${ladder}`
  const left = recoveryBudgetRemainingMs(budget)
  if (left === Infinity) return head
  return left <= 0 ? `${head}; the ${words} ends with this wait` : `${head}; ${retrySeconds(left)} of the ${words} left`
}

function shortAnswer(budget: RecoveryBudget): string {
  const cause = budget.lastCause ?? ''
  if (/busy/.test(cause)) return 'HTTP 429, busy'
  if (/overloaded/.test(cause)) return 'HTTP 529, overloaded'
  if (budget.lastStatus !== undefined) return `HTTP ${budget.lastStatus}, a wait it asked for`
  return 'no status'
}

export function recoveryBudgetSpentLine(budget: RecoveryBudget): string {
  return `the provider refused ${budget.waits} time${budget.waits === 1 ? '' : 's'} in a row (${shortAnswer(budget)}) — the ${recoveryBudgetWords(budget)} is spent and the agent stopped; retry when it clears, or raise MERCURY_RECOVERY_BUDGET_MINUTES`
}

export function isRecoveryBudgetSpentLine(text: string): boolean {
  return /^the provider refused \d+ times? in a row \(/.test(text) && text.includes('retry budget is spent')
}

export function recoveryNoticeFacts(message: unknown): RecoveryNoticeFacts | null {
  const m = message as
    | {
        type?: string
        subtype?: string
        retryInMs?: unknown
        recoveryTimeoutMs?: unknown
        retryAttempt?: unknown
        maxRetries?: unknown
        errorDetail?: { status?: unknown; message?: unknown }
        error?: unknown
      }
    | null
  if (!m || m.type !== 'system' || m.subtype !== 'api_error') return null
  const retryInMs = typeof m.retryInMs === 'number' && m.retryInMs > 0 ? m.retryInMs : 0
  const ceilingMs = typeof m.recoveryTimeoutMs === 'number' && m.recoveryTimeoutMs > 0 ? m.recoveryTimeoutMs : 0
  const declared = retryInMs > 0 ? retryInMs : ceilingMs
  if (declared <= 0) return null
  const own = (m.error as { status?: unknown; message?: unknown } | null | undefined) ?? undefined
  const status =
    typeof m.errorDetail?.status === 'number' ? m.errorDetail.status : typeof own?.status === 'number' ? own.status : undefined
  const words = typeof own?.message === 'string' ? own.message : typeof m.errorDetail?.message === 'string' ? m.errorDetail.message : ''
  const providerDeclared = retryAfterOf(m.error) !== undefined
  const kind: RecoveryWaitClass =
    retryInMs <= 0 && ceilingMs > 0
      ? 'recovery'
      : status === 429 || status === 529 || words.includes(OVERLOADED_MARKER) || providerDeclared
        ? 'throttle'
        : 'fault'
  return {
    declaredMs: declared,
    attempt: typeof m.retryAttempt === 'number' ? m.retryAttempt : undefined,
    of: typeof m.maxRetries === 'number' ? m.maxRetries : undefined,
    status,
    kind,
    providerDeclared: kind === 'throttle' && providerDeclared,
    cause: causeWords(kind, status, words),
    message: words,
  }
}
