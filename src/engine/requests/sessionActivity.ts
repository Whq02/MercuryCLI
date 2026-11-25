type SessionActivityReason = 'api_call' | 'tool_exec'

let refcount = 0
const perReason: Record<SessionActivityReason, number> = { api_call: 0, tool_exec: 0 }

export function sendSessionActivitySignal(): void {}

export function isSessionActivityTrackingActive(): boolean {
  return false
}

export function startSessionActivity(reason: SessionActivityReason): void {
  refcount++
  perReason[reason]++
}

export function stopSessionActivity(reason: SessionActivityReason): void {
  if (refcount > 0) refcount--
  if (perReason[reason] > 0) perReason[reason]--
}
