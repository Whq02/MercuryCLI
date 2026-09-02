/**
 * Pure, immutable counters used to decide when to stop auto-deciding and
 * fall back to prompting.
 */

/** Consecutive and total classifier-denial counters. */
export type DenialTrackingState = {
  consecutiveDenials: number
  totalDenials: number
}

/** The fall-back thresholds (both exported as one named constant object). */
export const DENIAL_LIMITS = { maxConsecutive: 3, maxTotal: 20 } as const

export function createDenialTrackingState(): DenialTrackingState {
  return { consecutiveDenials: 0, totalDenials: 0 }
}

/** Recording a denial increments both counters. */
export function recordDenial(state: DenialTrackingState): DenialTrackingState {
  return {
    consecutiveDenials: state.consecutiveDenials + 1,
    totalDenials: state.totalDenials + 1,
  }
}

/**
 * Recording a success resets the consecutive count to 0 — returning the SAME
 * object when it was already 0 (reference stability matters to React
 * consumers).
 */
export function recordSuccess(state: DenialTrackingState): DenialTrackingState {
  if (state.consecutiveDenials === 0) return state
  return { consecutiveDenials: 0, totalDenials: state.totalDenials }
}

/** Fall back to prompting at 3 consecutive or 20 total denials. */
export function shouldFallbackToPrompting(state: DenialTrackingState): boolean {
  return (
    state.consecutiveDenials >= DENIAL_LIMITS.maxConsecutive ||
    state.totalDenials >= DENIAL_LIMITS.maxTotal
  )
}
