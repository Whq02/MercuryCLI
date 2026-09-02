import type { SetAppState } from '../messageQueueManager.js'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  assertSingleRole,
  isImplementerRole,
  isScribeRole,
} from '../scribe/scribeGates.js'
import {
  registerScribeImplementerStopHook,
  unregisterScribeImplementerStopHook,
} from './scribeImplementerStopHook.js'
import { registerScribeDispatchGate, unregisterScribeDispatchGate } from './scribeDispatchGate.js'
import { resetBatchGate } from '../scribe/scribeBatchGate.js'

// ============================================================================
//  utils/hooks/scribeImplementerHooks.ts — engage/disengage the Scribe-mode
//  keep-working Stop hook, per role.
//
//  The wrapper PACK (utils/scribe) is the behavioral
//  layer the prompt *requests*; this is the harness layer that *enforces* the
//  keep-working discipline — since the settlement-effects move a typed TURN
//  ENGINE effect (query/settlementEffects.ts), no longer a Stop hook on the
//  user's hook registry. Engaged from QueryEngine when the process is in the
//  Scribe (MERCURY_SCRIBE) or Implementer (MERCURY_IMPLEMENTER) role; removed when
//  the mode turns off, so OFF is byte-identical (nothing engaged).
//
//  Env-opt-out-able (MERCURY_SCRIBE_HOOKS=0; the Mercury gate is absent
//  keeps the behavioral packs but skips the mechanical hook). Idempotent: a
//  per-role engaged flag + the fixed hook id mean re-engaging never duplicates.
// ============================================================================

/** Are the scribe/implementer mechanical hooks enabled for this build/session? */
export function scribeImplementerHooksEnabled(): boolean {
  return flagEnv('MERCURY_SCRIBE_HOOKS') !== '0'
}

// PER-SESSION engage guards:
// module-global booleans were PROCESS-global while hooks are stored PER
// sessionId, so after /clear (regenerateSessionId) or /resume the new session
// id never got its keep-working hook re-registered. Keyed by sessionId.
const scribeEngagedSessions = new Set<string>()
const implementerEngagedSessions = new Set<string>()

/** Whether the Scribe keep-working hook is currently engaged this session. */
export function areScribeHooksEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return scribeEngagedSessions.has(sessionId)
}

/** Whether the Implementer keep-working hook is currently engaged this session. */
export function areImplementerHooksEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return implementerEngagedSessions.has(sessionId)
}

/**
 * Engage the Scribe keep-working Stop hook. No-op (returns false) when the
 * fork/env gate is off or it is already engaged; true when it installed it.
 */
export function engageScribeHooks(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!scribeImplementerHooksEnabled()) return false
  // Role purity: a process tagged BOTH roles aborts loudly; a process tagged the
  // OTHER role refuses (returns false) so it registers exactly ONE keep-working
  // hook regardless of env accidents — never an in-process cross-role leak.
  assertSingleRole()
  if (isImplementerRole()) {
    logForDebugging(
      `[scribe] refused engage: process is the Implementer role, not the Scribe`,
    )
    return false
  }
  if (scribeEngagedSessions.has(sessionId)) return false
  registerScribeImplementerStopHook(sessionId, 'scribe')
  // #41 R6 source-gate: deny a 2nd normal dispatch at the SOURCE while one is in flight
  // (belt-and-suspenders with the daemon delivery back-pressure). Scribe process only.
  registerScribeDispatchGate(setAppState, sessionId)
  // #47 /batch: start every engaged session at the default (auto-approve) so a fresh
  // Scribe never inherits a stale manual pause from a prior session in the same process.
  resetBatchGate()
  scribeEngagedSessions.add(sessionId)
  logForDebugging(`[scribe] engaged keep-working hook + dispatch-gate for session ${sessionId}`)
  return true
}

/** Remove the Scribe keep-working Stop hook. */
export function disengageScribeHooks(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!scribeEngagedSessions.has(sessionId)) return false
  unregisterScribeImplementerStopHook(sessionId, 'scribe')
  unregisterScribeDispatchGate(setAppState, sessionId)
  scribeEngagedSessions.delete(sessionId)
  logForDebugging(`[scribe] disengaged keep-working hook + dispatch-gate for session ${sessionId}`)
  return true
}

/**
 * Engage the Implementer keep-working Stop hook. No-op (returns false) when the
 * fork/env gate is off or it is already engaged; true when it installed it.
 */
export function engageImplementerHooks(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!scribeImplementerHooksEnabled()) return false
  // Role purity (mirror of engageScribeHooks): both-roles aborts loudly; the
  // Scribe role refuses so the process registers exactly ONE keep-working hook.
  assertSingleRole()
  if (isScribeRole()) {
    logForDebugging(
      `[implementer] refused engage: process is the Scribe role, not the Implementer`,
    )
    return false
  }
  if (implementerEngagedSessions.has(sessionId)) return false
  registerScribeImplementerStopHook(sessionId, 'implementer')
  implementerEngagedSessions.add(sessionId)
  logForDebugging(`[implementer] engaged keep-working hook for session ${sessionId}`)
  return true
}

/** Remove the Implementer keep-working Stop hook. */
export function disengageImplementerHooks(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!implementerEngagedSessions.has(sessionId)) return false
  unregisterScribeImplementerStopHook(sessionId, 'implementer')
  implementerEngagedSessions.delete(sessionId)
  logForDebugging(`[implementer] disengaged keep-working hook for session ${sessionId}`)
  return true
}
