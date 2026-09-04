import { flagEnv } from '../../substrate/flagRegistry.js'

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
}

export function makeRecoveryBudget(capMs: number = recoveryBudgetMs()): RecoveryBudget {
  return { capMs, spentMs: 0, waits: 0, lastStatus: undefined }
}

export function recoveryBudgetRemainingMs(budget: RecoveryBudget): number {
  return budget.capMs === Infinity ? Infinity : Math.max(0, budget.capMs - budget.spentMs)
}

export function chargeRecoveryWait(
  budget: RecoveryBudget,
  declaredMs: number,
  status?: number,
): { honoredMs: number; spent: boolean } {
  const declared = Number.isFinite(declaredMs) && declaredMs > 0 ? declaredMs : 0
  const remaining = recoveryBudgetRemainingMs(budget)
  const honoredMs = Math.min(declared, remaining)
  budget.spentMs += honoredMs
  budget.waits += 1
  if (status !== undefined) budget.lastStatus = status
  return { honoredMs, spent: recoveryBudgetRemainingMs(budget) <= 0 }
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

export function retryWaitWords(args: {
  attempt: number
  of: number | undefined
  declaredMs: number
  honoredMs: number
  status: number | undefined
  budget: RecoveryBudget
}): string {
  const of = args.of !== undefined && args.of > 0 ? ` of ${args.of}` : ''
  const status = args.status !== undefined ? ` (HTTP ${args.status})` : ''
  const head = `provider throttled — retry ${args.attempt}${of} in ${retrySeconds(args.declaredMs)}${status}`
  if (args.honoredMs < args.declaredMs) {
    return `${head}; the ${recoveryBudgetWords(args.budget)} ends this wait after ${retrySeconds(args.honoredMs)}`
  }
  const left = recoveryBudgetRemainingMs(args.budget)
  return left === Infinity ? head : `${head}; ${retrySeconds(left)} of the ${recoveryBudgetWords(args.budget)} left`
}

export function recoveryBudgetSpentLine(budget: RecoveryBudget): string {
  const status = budget.lastStatus !== undefined ? ` (HTTP ${budget.lastStatus})` : ''
  return `provider throttled — the ${recoveryBudgetWords(budget)} is spent after ${budget.waits} declared wait${budget.waits === 1 ? '' : 's'}${status}; the agent stopped — retry later, or raise MERCURY_RECOVERY_BUDGET_MINUTES`
}

export function recoveryNoticeFacts(message: unknown): {
  declaredMs: number
  attempt: number | undefined
  of: number | undefined
  status: number | undefined
} | null {
  const m = message as
    | {
        type?: string
        subtype?: string
        retryInMs?: unknown
        recoveryTimeoutMs?: unknown
        retryAttempt?: unknown
        maxRetries?: unknown
        errorDetail?: { status?: unknown }
      }
    | null
  if (!m || m.type !== 'system' || m.subtype !== 'api_error') return null
  const declared =
    typeof m.retryInMs === 'number' && m.retryInMs > 0
      ? m.retryInMs
      : typeof m.recoveryTimeoutMs === 'number' && m.recoveryTimeoutMs > 0
        ? m.recoveryTimeoutMs
        : 0
  if (declared <= 0) return null
  const status = typeof m.errorDetail?.status === 'number' ? m.errorDetail.status : undefined
  return {
    declaredMs: declared,
    attempt: typeof m.retryAttempt === 'number' ? m.retryAttempt : undefined,
    of: typeof m.maxRetries === 'number' ? m.maxRetries : undefined,
    status,
  }
}
