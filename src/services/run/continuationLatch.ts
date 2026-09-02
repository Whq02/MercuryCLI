// ============================================================================
//  continuationLatch — exactly ONE continuation per stop attempt (Sol 5.6
//  frontier sprint).
//
//  Several keep-working hooks can evaluate the SAME stop (fable + self-check
//  + the default run hook + a role hook). Without coordination each issues
//  its own blocking re-prompt — duplicate continuations for one stop. The
//  latch makes the claim exact-once: the first hook to claim a given
//  (owner, stopAttempt) wins; every later claimant is told "already claimed"
//  and allows the stop (the winning re-prompt is already in flight).
//
//  A stop attempt is identified by the transcript position at evaluation
//  time (turn boundary index + message count): a NEW stop attempt after the
//  model's next try has a longer transcript, so the latch re-arms naturally.
//  Per-turn continuation counts live here too — the shared budget every
//  adapter draws from (reset at a REAL user-turn boundary).
// ============================================================================

import type { OwnerKey } from './ownerKey.js'
import { registerOwnerScopedStore } from './ownerLifecycle.js'
import { OwnerScopedStore } from './ownerScopedStore.js'

/** what the last ADMITTED continuation saw — the
 *  same revision tuple + the same next-action fingerprint may not open
 *  another provider call; any revision movement or a changed action re-arms. */
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

/** Identify the stop attempt from transcript shape (deterministic). */
export function stopAttemptId(turnIdx: number, messageCount: number): string {
  return `${turnIdx}:${messageCount}`
}

/** The last real (non-meta, non-tool-result) user frame — the turn boundary
 *  every keep-working hook keys its loop brake on. Lives HERE (2.2c) so
 *  every hook family claims through the same attempt identity without
 *  importing an adapter. */
export function turnBoundaryIndex(messages: readonly unknown[]): number {
  return (messages as ReadonlyArray<{ type?: string; isMeta?: boolean; toolUseResult?: unknown }>).findLastIndex(
    m => m?.type === 'user' && !m.isMeta && !m.toolUseResult,
  )
}

/** Reset the per-turn budget when a fresh user turn begins. */
function rollTurn(state: LatchState, turnIdx: number): void {
  if (state.turnIdx !== turnIdx) {
    state.turnIdx = turnIdx
    state.continuationsThisTurn = 0
    state.claimedAttemptId = null
    state.lastAttemptId = null
    state.lastAdmission = null
  }
}

/** The last ADMITTED continuation's record for this turn (A04-A06 input). */
export function lastAdmission(owner: OwnerKey, turnIdx: number): AdmissionRecord | null {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  return s.lastAdmission
}

/** Record what the just-claimed continuation saw (called by the adapter on a
 *  successful claim — the comparison state for the NEXT admission). */
export function recordAdmission(owner: OwnerKey, turnIdx: number, record: AdmissionRecord): void {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  s.lastAdmission = record
}

/** The pooled per-turn continuation count (all hooks). */
export function continuationsThisTurn(owner: OwnerKey, turnIdx: number): number {
  const s = latches.get(owner)
  rollTurn(s, turnIdx)
  return s.continuationsThisTurn
}

/**
 * Claim the continuation for this stop attempt. TRUE ⇒ the caller issues the
 * ONE re-prompt (the pooled counter advances). FALSE ⇒ another hook already
 * claimed this attempt — allow the stop; its re-prompt is in flight.
 */
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

/** TEST-ONLY: drop every latch. */
export function _resetContinuationLatchesForTesting(): void {
  latches.clearAllForShutdown()
}
