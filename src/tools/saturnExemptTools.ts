// =============================================================================
// Deferred-tool exemptions for the scheduling/notification channels (SATURN).
//
// A force-load carve-out: while their gates are on, these two tools are
// advertised with their FULL schema on turn 1 — never name-only behind tool
// search. Both are re-arm/notify primitives for autonomous runs, where a
// tool-search round-trip defeats the point: a self-paced loop tick should not
// need a search call just to re-arm its own wakeup, and the notification tool
// should be ready the moment a run goes unattended.
//
// Both tools are registered and live: PushNotification delivers local
// OS/terminal notifications (and reports pushSent:false honestly where a
// hosted mobile-push leg is unavailable); ScheduleWakeup is fully functional
// on SATURN's session-schedule road. Each declares shouldDefer, so these
// exemptions are load-bearing.
//
// Consumed by the deferred-tool predicate in ToolSearchTool/prompt.ts.
// =============================================================================

import { flagEnv } from '../substrate/flagRegistry.js'

/**
 * The PushNotification tool's wire name. A bare string — not an import from
 * the tool module — keeps this gate module import-light; the deferral check
 * only compares names.
 */
export const SATURN_EXEMPT_TOOL_A = 'PushNotification'

/** The ScheduleWakeup tool's wire name. */
export const SATURN_EXEMPT_TOOL_B = 'ScheduleWakeup'

/**
 * Should PushNotification skip deferral? Defaults yes; setting
 * MERCURY_SATURN_EXEMPT_PUSH=0 restores deferral. Consulted live per call.
 */
export function isSaturnExemptAEnabled(): boolean {
  return flagEnv('MERCURY_SATURN_EXEMPT_PUSH') !== '0'
}

/**
 * Should ScheduleWakeup skip deferral? Defaults yes; setting
 * MERCURY_SATURN_EXEMPT_WAKEUP=0 restores deferral. Consulted live per call.
 */
export function isSaturnExemptBEnabled(): boolean {
  return flagEnv('MERCURY_SATURN_EXEMPT_WAKEUP') !== '0'
}
