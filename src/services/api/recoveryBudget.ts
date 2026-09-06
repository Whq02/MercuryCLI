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

export type RecoveryWaitClass = 'throttle' | 'fault' | 'recovery'

export interface RecoveryBudget {
  capMs: number
  spentMs: number
  waits: number
  refusals: number
  faults: number
  recoveries: number
  lastStatus: number | undefined
  lastCause: string | undefined
}

export function makeRecoveryBudget(capMs: number = recoveryBudgetMs()): RecoveryBudget {
  return { capMs, spentMs: 0, waits: 0, refusals: 0, faults: 0, recoveries: 0, lastStatus: undefined, lastCause: undefined }
}

export function recoveryBudgetRemainingMs(budget: RecoveryBudget): number {
  return budget.capMs === Infinity ? Infinity : Math.max(0, budget.capMs - budget.spentMs)
}

export function refillRecoveryBudget(budget: RecoveryBudget): void {
  budget.spentMs = 0
  budget.waits = 0
  budget.refusals = 0
  budget.faults = 0
  budget.recoveries = 0
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
  kind: RecoveryWaitClass = 'throttle',
): { honoredMs: number; spent: boolean } {
  const declared = Number.isFinite(declaredMs) && declaredMs > 0 ? declaredMs : 0
  const remaining = recoveryBudgetRemainingMs(budget)
  const honoredMs = Math.min(declared, remaining)
  budget.spentMs += honoredMs
  budget.waits += 1
  if (kind === 'throttle') budget.refusals += 1
  else if (kind === 'fault') budget.faults += 1
  else budget.recoveries += 1
  if (status !== undefined) budget.lastStatus = status
  if (cause !== undefined) budget.lastCause = cause
  return { honoredMs, spent: recoveryBudgetRemainingMs(budget) <= 0 }
}

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

export interface RecoveryReservation {
  kind: RecoveryWaitClass
  honoredMs: number
  startedAtMs: number
  settled: boolean
}

export function honourRecoveryWait(
  budget: RecoveryBudget,
  facts: RecoveryNoticeFacts,
  nowMs: number = Date.now(),
): { honoredMs: number; spent: boolean; reservation: RecoveryReservation } {
  const { honoredMs, spent } = chargeRecoveryWait(budget, facts.declaredMs, facts.status, facts.cause, facts.kind)
  return { honoredMs, spent, reservation: { kind: facts.kind, honoredMs, startedAtMs: nowMs, settled: false } }
}

export function settleRecoveryWait(
  budget: RecoveryBudget,
  reservation: RecoveryReservation | null | undefined,
  nowMs: number = Date.now(),
): number {
  if (reservation === null || reservation === undefined || reservation.settled) return 0
  reservation.settled = true
  if (reservation.kind !== 'recovery') return 0
  const elapsed = Math.max(0, nowMs - reservation.startedAtMs)
  const refund = Math.max(0, reservation.honoredMs - elapsed)
  budget.spentMs = Math.max(0, budget.spentMs - refund)
  return refund
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
  const words = recoveryBudgetWords(budget)
  const off = budget.capMs === Infinity
  const ladder = `retry ${facts.attempt ?? budget.waits}${facts.of !== undefined && facts.of > 0 ? ` of ${facts.of}` : ''}`
  if (facts.kind === 'recovery') {
    const action = /reissu/i.test(facts.message) ? 'reissuing the stream' : 'one non-streamed answer'
    const head = `${facts.cause} — ${action}, up to ${retrySeconds(facts.declaredMs)}`
    if (honoredMs < facts.declaredMs) return `${head}; the ${words} ends it after ${retrySeconds(honoredMs)}`
    return off ? head : `${head}, within the ${words}`
  }
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

const RESUME_WORDS = 'the agent stopped; its work is kept — a message to it resumes it, or raise MERCURY_RECOVERY_BUDGET_MINUTES'

export function recoveryBudgetSpentLine(budget: RecoveryBudget): string {
  const words = recoveryBudgetWords(budget)
  const n = budget.waits
  if (n > 0 && budget.refusals === n) {
    return `the provider refused ${n} time${n === 1 ? '' : 's'} in a row (${shortAnswer(budget)}) — the ${words} is spent and ${RESUME_WORDS}`
  }
  const parts: string[] = []
  if (budget.recoveries > 0) parts.push(`${budget.recoveries} stream recover${budget.recoveries === 1 ? 'y' : 'ies'}`)
  if (budget.faults > 0) parts.push(`${budget.faults} provider fault${budget.faults === 1 ? '' : 's'}`)
  if (budget.refusals > 0) parts.push(`${budget.refusals} refusal${budget.refusals === 1 ? '' : 's'}`)
  const last = budget.lastCause !== undefined ? `; the last: ${budget.lastCause}` : ''
  return `the ${words} is spent waiting on the provider — ${n} wait${n === 1 ? '' : 's'} in a row (${parts.join(', ')}${last}) — ${RESUME_WORDS}`
}

export class RecoveryBudgetSpentError extends Error {
  readonly recoveryBudgetSpent = true as const
  readonly capMs: number
  readonly waits: number
  readonly refusals: number
  readonly faults: number
  readonly recoveries: number
  readonly lastStatus: number | undefined
  readonly lastCause: string | undefined
  readonly resumeAfterMs: number
  constructor(budget: RecoveryBudget, cut: { declaredMs: number; honoredMs: number }) {
    super(recoveryBudgetSpentLine(budget))
    this.name = 'RecoveryBudgetSpentError'
    this.capMs = budget.capMs
    this.waits = budget.waits
    this.refusals = budget.refusals
    this.faults = budget.faults
    this.recoveries = budget.recoveries
    this.lastStatus = budget.lastStatus
    this.lastCause = budget.lastCause
    this.resumeAfterMs = Math.max(0, cut.declaredMs - cut.honoredMs)
  }
}

export function recoveryBudgetSpentFactsOf(error: unknown): { words: string; resumeAfterMs: number; capMs: number; waits: number } | null {
  const e = error as { recoveryBudgetSpent?: unknown; message?: unknown; resumeAfterMs?: unknown; capMs?: unknown; waits?: unknown } | null
  if (e === null || typeof e !== 'object' || e.recoveryBudgetSpent !== true || typeof e.message !== 'string') return null
  return {
    words: e.message,
    resumeAfterMs: typeof e.resumeAfterMs === 'number' && Number.isFinite(e.resumeAfterMs) ? Math.max(0, e.resumeAfterMs) : 0,
    capMs: typeof e.capMs === 'number' ? e.capMs : 0,
    waits: typeof e.waits === 'number' ? e.waits : 0,
  }
}

export function isRecoveryBudgetSpentLine(text: string): boolean {
  return text.includes('retry budget is spent') && /^(the provider refused \d+ times? in a row \(|the \S+ retry budget is spent waiting on the provider)/.test(text)
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
