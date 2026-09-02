/* ============================================================================
   compactionPolicy — HARNESS-owned cache-aware compaction policy (item 2).
   ----------------------------------------------------------------------------
   Mercury has native autoCompact (autoCompact.ts: shouldAutoCompact fires
   at the effective-window-minus-buffer threshold; autoCompactIfNeeded runs the
   native circuit breaker at MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES). This module
   is a PURE pre-check Mercury consults at that existing decision point. It does
   two things, both ADDITIVE and one-directional so they can never change the
   API request or break compaction:

     (a) decideCompaction — signals "compact now" BELOW the native autocompact
         threshold (default 85% of the window used — deliberately close to the native
         native fire so the early-summary window is small), with a hysteresis
         re-arm and a turn cooldown so it doesn't thrash. The trigger only
         ADVANCES the decision when the native path wouldn't fire yet; it never SUPPRESSES a
         native fire, and it is opt-in (MERCURY_CTX_COMPACTION) — see
         the MERCURY_CTX_COMPACTION gate in autoCompact.ts.

     (b) compactionBreakerAllows — stop ATTEMPTING autocompact after N (default
         3) consecutive failed/doomed compactions. a known failure class: doomed
         autocompact loops burn ~250K API calls/day. The breaker only SUPPRESSES
         a doomed retry; it never lets through a retry the native path would have blocked
         (the default N matches MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, and an
         operator may only LOWER it).

   PURE: no node:*, no Date.now / no clock (callers pass the turn counter). Fail-
   closed: any missing/odd signal → 'none' / fail-open allow on absent tracking.
   Never throws. The decision surfaces: decideCompaction /
   compactionBreakerAllows / nextCompactionFailureCount.

   GATING is the CALLER's job: autoCompact.ts consults these only under
   isEnvTruthy(MERCURY_CTX_COMPACTION). OFF ⇒ the native compaction behavior is
   byte-unchanged (these functions are never called).
   ============================================================================ */

/** Tunables. The caller may override per-field; an absent field uses the default. */
export const COMPACTION_DEFAULTS = Object.freeze({
  // Fire at/above this window-fill % — deliberately below the native autocompact
  // (the native path fires at ~effective-window-minus-13k, high-90s % of effective) but
  // close enough that an advance only pre-empts a small sliver of headroom. An
  // earlier value (e.g. 70) summarized aggressively and silently forgot live
  // context; 85 keeps most of the window granular until just before the native fire.
  thresholdPct: 85,
  // Never re-fire within this many turns of the last fire.
  cooldownTurns: 8,
  // After a fire, also require the fill to have dipped below this once
  // (hysteresis re-arm — proves the compaction actually bought room).
  rearmBelowPct: 55,
})

/** #58 — stop retrying doomed compactions after this many consecutive failures.
 *  Matches MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES (autoCompact.ts) so the
 *  harness breaker is, by default, identical to the native one — it can only
 *  SUPPRESS a retry the native path would also (eventually) block, never permit one. */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3

export interface CompactionPolicy {
  thresholdPct?: number
  cooldownTurns?: number
  rearmBelowPct?: number
}

export interface CompactionState {
  lastFiredTurn?: number | null
  rearmed?: boolean
}

export interface DecideCompactionInput {
  /** Window-fill signal. percentage = % of the context window USED (0..100). */
  usage?: { percentage?: number } | null
  state?: CompactionState | null
  turn?: number
  policy?: CompactionPolicy
}

export interface DecideCompactionResult {
  action: 'none' | 'compact'
  reason: string
  state: { lastFiredTurn: number | null; rearmed: boolean }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Decide whether the harness should advance compaction now. PURE + fail-closed:
 * with no usage or no turn signal it returns 'none' (defers to the native path). The
 * caller only ACTS on action:'compact' when native shouldAutoCompact returned
 * false — so this can only ADVANCE the moment, never suppress a native fire.
 */
export function decideCompaction(
  input: DecideCompactionInput,
): DecideCompactionResult {
  const i = input && typeof input === 'object' ? input : {}
  const pol = {
    ...COMPACTION_DEFAULTS,
    ...(i.policy && typeof i.policy === 'object' ? i.policy : {}),
  }
  const st = i.state && typeof i.state === 'object' ? i.state : {}
  const lastFiredTurn = isFiniteNumber(st.lastFiredTurn) ? st.lastFiredTurn : null
  const rearmed = st.rearmed !== false // a fresh session starts armed
  const turn = isFiniteNumber(i.turn) ? i.turn : null
  const pct =
    i.usage && typeof i.usage === 'object' && isFiniteNumber(i.usage.percentage)
      ? i.usage.percentage
      : null

  const keep = (
    reason: string,
    nextRearmed: boolean = rearmed,
  ): DecideCompactionResult => ({
    action: 'none',
    reason,
    state: { lastFiredTurn, rearmed: nextRearmed },
  })

  if (pct === null) return keep('no usage signal (fail-closed)')
  if (turn === null) return keep('no turn counter (fail-closed)')

  // Hysteresis re-arm: after a fire we stay disarmed until the fill dips below
  // rearmBelowPct (i.e. the compaction actually happened and bought room).
  const nowRearmed = rearmed || pct < pol.rearmBelowPct
  if (pct < pol.thresholdPct) {
    return keep(
      `fill ${pct}% below threshold ${pol.thresholdPct}%`,
      nowRearmed,
    )
  }
  if (!nowRearmed) {
    return keep(
      `disarmed until fill dips below ${pol.rearmBelowPct}% (last fire bought no room yet)`,
      nowRearmed,
    )
  }
  if (lastFiredTurn !== null && turn - lastFiredTurn < pol.cooldownTurns) {
    return keep(
      `cooldown: fired at turn ${lastFiredTurn}, ${pol.cooldownTurns - (turn - lastFiredTurn)} turns left`,
      nowRearmed,
    )
  }
  return {
    action: 'compact',
    reason: `window fill ${pct}% >= ${pol.thresholdPct}% — advance compaction`,
    state: { lastFiredTurn: turn, rearmed: false },
  }
}

/**
 * #58 — may another autocompact attempt run? Fail-OPEN on absent/garbage
 * tracking (a fresh session has no failure history), closed once the breaker
 * trips at `limit` (default = MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES). The
 * caller uses this to SUPPRESS a doomed retry; it never permits one the native path blocks.
 */
export function compactionBreakerAllows(
  consecutiveFailures: number | undefined,
  limit: number = MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
): boolean {
  const cap =
    isFiniteNumber(limit) && limit > 0
      ? Math.floor(limit)
      : MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  if (!isFiniteNumber(consecutiveFailures)) return true
  return consecutiveFailures < cap
}

/**
 * #58 — fold an attempt outcome into the failure count: success resets to 0,
 * failure increments. The caller threads the count through the existing
 * AutoCompactTrackingState.consecutiveFailures so the NEXT loop iteration can
 * skip futile retries.
 */
export function nextCompactionFailureCount(
  prev: number | undefined,
  succeeded: boolean,
): number {
  const p =
    isFiniteNumber(prev) && prev > 0 ? Math.floor(prev) : 0
  return succeeded ? 0 : p + 1
}

/**
 * Derive the window-fill PERCENT USED (0..100) from the native percentLeft signal
 * (calculateTokenWarningState returns percentLeft against the active threshold).
 * percentUsed = 100 - percentLeft, clamped. Pure, never throws.
 */
export function percentUsedFromPercentLeft(percentLeft: number): number {
  if (!isFiniteNumber(percentLeft)) return 0
  return Math.min(100, Math.max(0, 100 - percentLeft))
}
