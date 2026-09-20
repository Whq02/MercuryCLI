import { flagEnv } from '../../substrate/flagRegistry.js'
import { retrySeconds } from '../api/recoveryBudget.js'

export const BUSY_RETRY_RUNGS_MS: readonly number[] = Object.freeze([1_000, 2_000, 4_000, 8_000, 16_000, 30_000])
export const BUSY_RETRY_QUIET_MS = 30_000

export function busyRetryScale(): number {
  const raw = flagEnv('MERCURY_BUSY_RETRY_SCALE')
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

export function isBusyRefusal(fault: { code: string; status?: number; retryable: boolean }): boolean {
  if (!fault.retryable) return false
  if (fault.status === 503 || fault.status === 529) return true
  const word = fault.code.startsWith('api-') ? fault.code.slice('api-'.length) : ''
  return word === 'UNAVAILABLE' || /overload/i.test(word)
}

export interface BusyRetryLadder {
  readonly rungsMs: readonly number[]
  readonly quietMs: number
  readonly budgetMs: number
  readonly startedAtMs: number
  rung: number
  spentMs: number
  readonly waitsMs: number[]
}

export function openBusyRetryLadder(nowMs: number, scale: number = busyRetryScale()): BusyRetryLadder {
  const rungsMs = BUSY_RETRY_RUNGS_MS.map(ms => Math.max(1, Math.round(ms * scale)))
  return {
    rungsMs,
    quietMs: Math.round(BUSY_RETRY_QUIET_MS * scale),
    budgetMs: rungsMs.reduce((sum, ms) => sum + ms, 0),
    startedAtMs: nowMs,
    rung: 0,
    spentMs: 0,
    waitsMs: [],
  }
}

export interface BusyRetryStep {
  waitMs: number
  quiet: boolean
  attempt: number
  of: number
}

export function nextBusyRetry(ladder: BusyRetryLadder, askedMs: number | undefined, nowMs: number): BusyRetryStep | null {
  const left = ladder.budgetMs - ladder.spentMs
  if (ladder.rung >= ladder.rungsMs.length || left <= 0) return null
  let waitMs = Math.min(ladder.rungsMs[ladder.rung]!, left)
  if (askedMs !== undefined && Number.isFinite(askedMs) && askedMs > waitMs) waitMs = askedMs
  const attempt = ladder.rung + 1
  let of = attempt
  let remaining = left - waitMs
  for (let rung = ladder.rung + 1; rung < ladder.rungsMs.length && remaining > 0; rung++) {
    of++
    remaining -= Math.min(ladder.rungsMs[rung]!, remaining)
  }
  const quiet = nowMs - ladder.startedAtMs < ladder.quietMs
  ladder.rung++
  ladder.spentMs += waitMs
  ladder.waitsMs.push(waitMs)
  return { waitMs, quiet, attempt, of }
}

const ORDINALS = ['second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth']

export function busyRecoveryDetail(input: { provider: string; status: number | undefined; code: string; message: string; waitsMs: readonly number[] }): string {
  const waits = input.waitsMs.map(ms => retrySeconds(ms))
  const list = waits.length <= 1 ? waits.join('') : `${waits.slice(0, -1).join(', ')} and ${waits[waits.length - 1]}`
  const ordinal = ORDINALS[Math.min(waits.length, ORDINALS.length) - 1] ?? 'next'
  const status = input.status !== undefined ? ` HTTP ${input.status}` : ''
  const words = input.message !== '' ? `: ${input.message}` : ''
  return `${input.provider} answered${status} (${input.code})${words} — retried after ${list}, and the ${ordinal} request was answered.`
}
