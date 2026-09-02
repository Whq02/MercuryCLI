/**
 * Scribe Mode "Amanuensis" — self-regulation. The Scribe periodically (on each
 * heartbeat wake) assesses the health of the run and recommends a remediation:
 *   - clear-implementer : the Implementer's context is near full → tell it to
 *                         /clear (or restart it) before it degrades;
 *   - pause             : repeated errors / thrash → pause the loop rather than
 *                         burn tokens spinning;
 *   - escalate-human    : a HARD cumulative-token ceiling was crossed → escalate
 *                         to the OPERATOR (not just the Scribe): only the human
 *                         decides whether to keep spending.
 *
 * This module is the pure DECISION logic; the context % comes from the existing
 * calculateContextPercentages() at the call site, and the error/token counters
 * from the session snapshot. Severity order: escalate-human > pause >
 * clear-implementer > ok.
 */
import { scribeModeEnabled } from './scribeGates.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** Implementer context usage (%) at/above which to clear it. */
export const REGULATION_CONTEXT_CLEAR_PCT = 85
/** Consecutive errors / thrash count at/above which to pause. */
export const REGULATION_THRASH_ERRORS = 5
/** Default hard cumulative-token ceiling before escalating to the human. */
export const REGULATION_TOKEN_CEILING_DEFAULT = 5_000_000

/** Whether self-regulation runs (Scribe process only). */
export function scribeRegulationEnabled(): boolean {
  return scribeModeEnabled()
}

/** The hard token ceiling, env-tunable via MERCURY_SCRIBE_TOKEN_CEILING (>0). */
export function getScribeTokenCeiling(): number {
  const raw = flagEnv('MERCURY_SCRIBE_TOKEN_CEILING')
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : REGULATION_TOKEN_CEILING_DEFAULT
}

export interface RegulationSnapshot {
  /** Implementer context usage 0..100 (from calculateContextPercentages). */
  contextPercent?: number
  /** Consecutive errors / thrash signal. */
  repeatedErrors?: number
  /** Cumulative tokens spent this session. */
  tokenTotal?: number
}

export type RegulationAction = 'ok' | 'clear-implementer' | 'pause' | 'escalate-human'

export interface RegulationVerdict {
  action: RegulationAction
  reason: string
}

/**
 * Assess a snapshot and return the most-severe applicable remediation. Robust to
 * missing fields (treated as 0 / healthy).
 */
export function assessRegulation(s: RegulationSnapshot): RegulationVerdict {
  const tokens = Number.isFinite(s.tokenTotal) ? (s.tokenTotal as number) : 0
  const errors = Number.isFinite(s.repeatedErrors) ? (s.repeatedErrors as number) : 0
  const ctx = Number.isFinite(s.contextPercent) ? (s.contextPercent as number) : 0

  const ceiling = getScribeTokenCeiling()
  if (tokens >= ceiling) {
    return {
      action: 'escalate-human',
      reason: `cumulative tokens ${tokens} reached the hard ceiling ${ceiling} — escalate to the human/operator: only they decide whether to keep spending`,
    }
  }
  if (errors >= REGULATION_THRASH_ERRORS) {
    return {
      action: 'pause',
      reason: `${errors} repeated errors (thrash >= ${REGULATION_THRASH_ERRORS}) — pause the loop instead of spinning`,
    }
  }
  if (ctx >= REGULATION_CONTEXT_CLEAR_PCT) {
    return {
      action: 'clear-implementer',
      reason: `Implementer context at ${ctx}% (>= ${REGULATION_CONTEXT_CLEAR_PCT}%) — clear/restart it before it degrades`,
    }
  }
  return { action: 'ok', reason: 'within limits' }
}
