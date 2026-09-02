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


export function scribeImplementerHooksEnabled(): boolean {
  return flagEnv('MERCURY_SCRIBE_HOOKS') !== '0'
}

const scribeEngagedSessions = new Set<string>()
const implementerEngagedSessions = new Set<string>()

export function areScribeHooksEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return scribeEngagedSessions.has(sessionId)
}

export function areImplementerHooksEngaged(
  sessionId: string = getSessionId(),
): boolean {
  return implementerEngagedSessions.has(sessionId)
}

export function engageScribeHooks(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!scribeImplementerHooksEnabled()) return false
  assertSingleRole()
  if (isImplementerRole()) {
    logForDebugging(
      `[scribe] refused engage: process is the Implementer role, not the Scribe`,
    )
    return false
  }
  if (scribeEngagedSessions.has(sessionId)) return false
  registerScribeImplementerStopHook(sessionId, 'scribe')
  registerScribeDispatchGate(setAppState, sessionId)
  resetBatchGate()
  scribeEngagedSessions.add(sessionId)
  logForDebugging(`[scribe] engaged keep-working hook + dispatch-gate for session ${sessionId}`)
  return true
}

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

export function engageImplementerHooks(
  setAppState: SetAppState,
  sessionId: string = getSessionId(),
): boolean {
  if (!scribeImplementerHooksEnabled()) return false
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
