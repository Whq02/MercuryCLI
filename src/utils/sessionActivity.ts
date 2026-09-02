import { logForDiagnosticsNoPII } from './diagLogs.js'
import { registerCleanup } from './cleanupRegistry.js'


export type SessionActivityReason = 'api_call' | 'tool_exec'

const keepAliveCallback: (() => void) | null = null

let refcount = 0
const perReason: Record<SessionActivityReason, number> = { api_call: 0, tool_exec: 0 }
let oldestActivityStartMs: number | null = null
let shutdownDiagnosticRegistered = false

export function sendSessionActivitySignal(): void {
  keepAliveCallback?.()
}

export function isSessionActivityTrackingActive(): boolean {
  return keepAliveCallback !== null
}

export function startSessionActivity(reason: SessionActivityReason): void {
  if (refcount === 0) oldestActivityStartMs = Date.now()
  refcount++
  perReason[reason]++
  if (!shutdownDiagnosticRegistered) {
    shutdownDiagnosticRegistered = true
    registerCleanup(async () => {
      logForDiagnosticsNoPII('info', 'session_activity_at_shutdown', {
        refcount,
        active: { ...perReason },
        oldest_activity_ms: refcount > 0 && oldestActivityStartMs !== null ? Date.now() - oldestActivityStartMs : null,
      })
    })
  }
}

export function stopSessionActivity(reason: SessionActivityReason): void {
  if (refcount > 0) refcount--
  if (perReason[reason] > 0) perReason[reason]--
  if (refcount === 0) oldestActivityStartMs = null
}
