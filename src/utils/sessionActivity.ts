import { logForDiagnosticsNoPII } from './diagLogs.js'
import { registerCleanup } from './cleanupRegistry.js'

/**
 * Refcounted session-activity tracking. The transport that would register a
 * keep-alive callback is not in this tree, so the register/unregister
 * surface and the heartbeat/idle timers it would arm are not built (per the
 * drop-dead-machinery ruling); what stays live is the refcount and
 * per-reason bookkeeping (the API stream and tool execution bracket their
 * work), the shutdown diagnostic, and the always-inert signal/predicate the
 * compaction path calls.
 */

export type SessionActivityReason = 'api_call' | 'tool_exec'

/** Always absent in this tree — the register export is not built. */
const keepAliveCallback: (() => void) | null = null

let refcount = 0
const perReason: Record<SessionActivityReason, number> = { api_call: 0, tool_exec: 0 }
let oldestActivityStartMs: number | null = null
let shutdownDiagnosticRegistered = false

/** A no-op in this tree: the callback is always absent and no keepalive
 *  env gate exists. */
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
        // Stale otherwise: the age is real only while work is in flight.
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
