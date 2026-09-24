import {
  JEV_MAX_CALL_USD,
  JEV_SUBAGENT_CALL_BUDGET,
  type JevLocalRefusalKind,
  type JevStatusKind,
  type JevUsage,
  type JevWireFailure,
  type JevWireFailureKind,
  jevChargeUsd,
  jevRefusalNamesCredit,
  jevUsdLabel,
  jevWaitLabel,
} from './jevContract.js'
import type { JevSettings } from './jevSetting.js'

export const JEV_PACE_WINDOW_MS = 60_000
export const JEV_COOL_DOWN_BASE_MS = 30_000
export const JEV_COOL_DOWN_CAP_MS = 10 * 60_000
export const JEV_COOL_DOWN_JITTER = 0.25
export const JEV_HOLD_CEILING_MS = 24 * 60 * 60_000
const STREAK_DECAY_MS = 2 * JEV_COOL_DOWN_CAP_MS

export interface JevWireRecord {
  kind: JevWireFailureKind
  status?: number
  detail: string
  at: number
  retryAfterMs?: number
  requestId?: string
}

export interface JevLedgerSnapshot {
  spendUsd: number
  calls: number
  attempts: number
  inputTokens: number
  unconfirmedCharges: number
  attemptsThisMinute: number
  lastWire: JevWireRecord | null
  holdUntil: number
  refusals: number
  subagentAttempts: Readonly<Record<string, number>>
  lastAnsweredAt: number | null
  lastModel: string | null
}

export type JevAdmission = { ok: true } | { ok: false; kind: JevLocalRefusalKind; words: string; retryInMs?: number }

interface LedgerState {
  spendUsd: number
  calls: number
  attempts: number
  inputTokens: number
  unconfirmedCharges: number
  attemptTimes: number[]
  subagentAttempts: Map<string, number>
  lastWire: JevWireRecord | null
  holdUntil: number
  refusals: number
  lastRefusalAt: number
  notices: Set<JevStatusKind>
  lastAnsweredAt: number | null
  lastModel: string | null
}

function fresh(): LedgerState {
  return {
    spendUsd: 0,
    calls: 0,
    attempts: 0,
    inputTokens: 0,
    unconfirmedCharges: 0,
    attemptTimes: [],
    subagentAttempts: new Map(),
    lastWire: null,
    holdUntil: 0,
    refusals: 0,
    lastRefusalAt: 0,
    notices: new Set(),
    lastAnsweredAt: null,
    lastModel: null,
  }
}

let state: LedgerState = fresh()

function pruneWindow(now: number): void {
  const floor = now - JEV_PACE_WINDOW_MS
  while (state.attemptTimes.length > 0 && state.attemptTimes[0]! <= floor) state.attemptTimes.shift()
}

export function jevLedgerSnapshot(now: number = Date.now()): JevLedgerSnapshot {
  pruneWindow(now)
  return {
    spendUsd: state.spendUsd,
    calls: state.calls,
    attempts: state.attempts,
    inputTokens: state.inputTokens,
    unconfirmedCharges: state.unconfirmedCharges,
    attemptsThisMinute: state.attemptTimes.length,
    lastWire: state.lastWire,
    holdUntil: state.holdUntil,
    refusals: state.refusals,
    subagentAttempts: Object.fromEntries(state.subagentAttempts),
    lastAnsweredAt: state.lastAnsweredAt,
    lastModel: state.lastModel,
  }
}

export function jevCoolDownWindowMs(refusals: number, random: () => number): number {
  const streak = Math.max(1, refusals)
  const nominal = Math.min(JEV_COOL_DOWN_CAP_MS, JEV_COOL_DOWN_BASE_MS * 2 ** (streak - 1))
  const jitter = 1 + (random() * 2 - 1) * JEV_COOL_DOWN_JITTER
  return Math.round(nominal * jitter)
}

export function jevAdmission(settings: JevSettings, now: number = Date.now(), agentId?: string): JevAdmission {
  pruneWindow(now)
  if (state.spendUsd + JEV_MAX_CALL_USD > settings.allowanceUsd) {
    return {
      ok: false,
      kind: 'allowance-hit',
      words: `allowance hit — Mercury counts ${jevUsdLabel(state.spendUsd)} of the ${jevUsdLabel(settings.allowanceUsd)} session allowance and one more call could pass it; /clear resets the count, /jev raises the allowance`,
    }
  }
  if (settings.requestCeiling !== null && state.attempts >= settings.requestCeiling) {
    return {
      ok: false,
      kind: 'ceiling-hit',
      words: `request ceiling hit — ${state.attempts} of ${settings.requestCeiling} requests this session; /clear resets the count, /jev raises or clears the ceiling`,
    }
  }
  if (state.attemptTimes.length >= settings.pacePerMinute) {
    const retryInMs = Math.max(1, state.attemptTimes[0]! + JEV_PACE_WINDOW_MS - now)
    return {
      ok: false,
      kind: 'pace-hit',
      words: `pace hit — ${state.attemptTimes.length} requests in the last minute is the pace set in /jev (${settings.pacePerMinute} a minute); the next is admitted in ${jevWaitLabel(retryInMs)}`,
      retryInMs,
    }
  }
  if (agentId !== undefined && (state.subagentAttempts.get(agentId) ?? 0) >= JEV_SUBAGENT_CALL_BUDGET) {
    return {
      ok: false,
      kind: 'subagent-budget-hit',
      words: `sub-agent budget hit — this agent has used its ${JEV_SUBAGENT_CALL_BUDGET} JEV calls; carry on unaided`,
    }
  }
  return { ok: true }
}

export function noteJevAttempt(now: number = Date.now(), agentId?: string): void {
  pruneWindow(now)
  state.attempts += 1
  state.attemptTimes.push(now)
  if (agentId !== undefined) state.subagentAttempts.set(agentId, (state.subagentAttempts.get(agentId) ?? 0) + 1)
}

export function settleJevCall(usage: JevUsage, model: string, now: number = Date.now()): number {
  const charge = jevChargeUsd(usage.input_tokens)
  state.spendUsd += charge
  state.calls += 1
  state.inputTokens += Math.max(0, usage.input_tokens)
  state.lastWire = null
  state.holdUntil = 0
  state.refusals = 0
  state.lastAnsweredAt = now
  state.lastModel = model
  return charge
}

export function noteJevWireFailure(failure: JevWireFailure, now: number = Date.now(), random: () => number = Math.random): number {
  state.lastWire = {
    kind: failure.kind,
    status: failure.status,
    detail: failure.detail,
    at: now,
    retryAfterMs: failure.retryAfterMs,
    requestId: failure.requestId,
  }
  if (failure.kind === 'parse-failed' || failure.kind === 'aborted') {
    state.unconfirmedCharges += 1
    state.spendUsd += JEV_MAX_CALL_USD
  }
  if (failure.kind === 'invalid-key' || failure.kind === 'bad-request' || failure.kind === 'aborted') return 0
  if (failure.kind === 'provider-refused' && jevRefusalNamesCredit(failure.detail)) {
    state.holdUntil = Number.MAX_SAFE_INTEGER
    return Number.MAX_SAFE_INTEGER
  }
  state.refusals = now - state.lastRefusalAt <= STREAK_DECAY_MS ? state.refusals + 1 : 1
  state.lastRefusalAt = now
  const ladder = jevCoolDownWindowMs(state.refusals, random)
  const window = Math.min(JEV_HOLD_CEILING_MS, Math.max(ladder, failure.retryAfterMs ?? 0))
  state.holdUntil = now + window
  return window
}

export function noteJevKeyChanged(): void {
  if (state.lastWire?.kind === 'invalid-key') state.lastWire = null
  if (state.lastWire?.kind === 'provider-refused' && jevRefusalNamesCredit(state.lastWire.detail)) {
    state.lastWire = null
    state.holdUntil = 0
  }
  state.notices.delete('invalid-key')
  state.notices.delete('no-key')
}

export function takeJevNotice(kind: JevStatusKind): boolean {
  if (state.notices.has(kind)) return false
  state.notices.add(kind)
  return true
}

export function resetJevLedger(): void {
  state = fresh()
}
