
import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'

export interface AdmissionRecord {
  revision: {
    runRevision: number
    effectRevision: number
    evidenceRevision: number
    externalRevision: number
  }
  nextActionFingerprint: string
  attempt: number
}

interface LatchState {
  lastAttemptId: string | null
  claimedAttemptId: string | null
  turnIdx: number
  continuationsThisTurn: number
  lastAdmission: AdmissionRecord | null
}

const latches = new OwnerScopedStore<LatchState>({
  name: 'continuation-latch',
  create: () => ({
    lastAttemptId: null,
    claimedAttemptId: null,
    turnIdx: -1,
    continuationsThisTurn: 0,
    lastAdmission: null,
  }),
})
registerOwnerScopedStore(latches)

export function stopAttemptId(turnIdx: number, messageCount: number): string {
  return `${turnIdx}:${messageCount}`
}

export function turnBoundaryIndex(messages: readonly unknown[]): number {
  return (messages as ReadonlyArray<{ type?: string; isMeta?: boolean; toolUseResult?: unknown }>).findLastIndex(
    m => m?.type === 'user' && !m.isMeta && !m.toolUseResult,
  )
}

function rollTurn(state: LatchState, turnIdx: number): void {
  if (state.turnIdx !== turnIdx) {
    state.turnIdx = turnIdx
    state.continuationsThisTurn = 0
    state.claimedAttemptId = null
    state.lastAttemptId = null
    state.lastAdmission = null
  }
}

export function lastAdmission(owner: OwnerKey, turnIdx: number): AdmissionRecord | null {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  return s.lastAdmission
}

export function recordAdmission(owner: OwnerKey, turnIdx: number, record: AdmissionRecord): void {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  s.lastAdmission = record
}

export function continuationsThisTurn(owner: OwnerKey, turnIdx: number): number {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  return s.continuationsThisTurn
}

export function claimContinuation(
  owner: OwnerKey,
  turnIdx: number,
  messageCount: number,
): boolean {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  const attempt = stopAttemptId(turnIdx, messageCount)
  if (s.claimedAttemptId === attempt) return false
  s.claimedAttemptId = attempt
  s.lastAttemptId = attempt
  s.continuationsThisTurn++
  return true
}

export function _resetContinuationLatchesForTesting(): void {
  latches.clearAllForShutdown()
}
