
import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'

interface LatchState {
  lastAttemptId: string | null
  claimedAttemptId: string | null
  turnIdx: number
  continuationsThisTurn: number
}

const latches = new OwnerScopedStore<LatchState>({
  name: 'continuation-latch',
  create: () => ({
    lastAttemptId: null,
    claimedAttemptId: null,
    turnIdx: -1,
    continuationsThisTurn: 0,
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
  }
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
