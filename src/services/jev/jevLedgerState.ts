import type { JevRoad, JevStatusKind, JevWireFailure } from './jevContract.js'

export interface JevWireRecord extends JevWireFailure {
  at: number
}

export interface LedgerState {
  spendUsd: number
  lastCostUsd: number | null
  lastRequestId: string | null
  calls: number
  attempts: number
  inputTokens: number
  unconfirmedCharges: number
  attemptTimes: number[]
  subagentAttemptTimes: number[]
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
    lastCostUsd: null,
    lastRequestId: null,
    calls: 0,
    attempts: 0,
    inputTokens: 0,
    unconfirmedCharges: 0,
    attemptTimes: [],
    subagentAttemptTimes: [],
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

export const states: Record<JevRoad, LedgerState> = { official: fresh(), openrouter: fresh() }

export function resetJevLedger(): void {
  states.official = fresh()
  states.openrouter = fresh()
}
