// ============================================================================
//  utils/cockpit/ctxForecast — "≈N turns to autocompact" (uniqueness-program P7;
//  OWNER-ADDRESSED since the Sol 5.6 frontier sprint).
//
//  Pure + React-free (provable). Sampling piggybacks on the existing
//  publishContextUsage seam (MercuryFrame publishes the real getCurrentUsage
//  result every render — no new producer): each INCREASE in usedPct is one
//  growth step ≈ one turn's appetite. The estimate is the remaining headroom
//  to the autocompact threshold over the mean of the last GROWTH_SAMPLES
//  steps — ceil'd, and null until 2 real steps exist (an honest "don't know
//  yet", never a fabricated number).
//
//  OWNER MODEL: each conversation owner keeps its own
//  {deltas, lastPct, turnAnchorPct} in a bounded OwnerScopedStore. Two
//  conversations at similar usage no longer merge growth histories — the old
//  singleton could only infer a switch from a ≥5-point usage DROP, which an
//  ordinary 40%↔42% switch never trips. The drop-reset survives PER OWNER
//  (an in-place /clear or compaction still re-anchors that owner's trend).
//
//  Flag: MERCURY_CTX_FORECAST — default-ON (graduated, tier `display`).
//  `=0` opts out ⇒ the sampler is inert and the rail renders byte-identically.
// ============================================================================

import type { OwnerKey } from '../../services/run/ownerKey.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function ctxForecastEnabled(): boolean {
  if (flagEnv('MERCURY_CTX_FORECAST') === '0') return false
  return true
}

/** Mean growth window — long enough to smooth tool-heavy vs prose turns,
 *  short enough to track a regime change within a few turns. */
const GROWTH_SAMPLES = 8
/** Below this pct-point delta a publish is a repaint, not a growth step. */
const MIN_STEP = 0.1
/** A drop this large is a compaction/clear — the owner's history resets. */
const RESET_DROP = 5

interface ForecastState {
  deltas: number[]
  lastPct: number | null
  // The pct at the LAST completed user-turn boundary — one turn's appetite is
  // (lastPct − turnAnchorPct) at the boundary, however many API/tool rounds
  // the turn ran internally.
  turnAnchorPct: number | null
}

const forecasts = new OwnerScopedStore<ForecastState>({
  name: 'ctx-forecast',
  create: () => ({ deltas: [], lastPct: null, turnAnchorPct: null }),
})
registerOwnerScopedStore(forecasts)

function stateFor(owner?: OwnerKey): ForecastState {
  return forecasts.get(owner ?? processMainOwner())
}

/**
 * Feed one published usedPct sample (called from publishContextUsage).
 *
 * TRACKING ONLY — no growth observation is recorded here. The orchestration
 * loop publishes usage after EVERY internal API round, so per-publish deltas
 * measured ROUNDS, not turns. Growth is observed at noteCtxTurnBoundary() —
 * one completed user turn, one observation.
 */
export function recordCtxSample(usedPct: number | null, owner?: OwnerKey): void {
  if (usedPct == null) return
  const s = stateFor(owner)
  if (s.lastPct == null) {
    s.lastPct = usedPct
    s.turnAnchorPct = usedPct
    return
  }
  const d = usedPct - s.lastPct
  // Self-reset on a non-monotone DROP (≥RESET_DROP points): an in-place
  // /clear or an autocompact invalidates THIS owner's growth trend. Detected
  // LIVE (mid-turn), not just at boundaries — the post-compaction pct must
  // re-anchor before the turn ends. (Cross-conversation contamination is
  // solved by owner keying, not by this heuristic.)
  if (d <= -RESET_DROP) {
    s.deltas.length = 0
    s.lastPct = usedPct
    s.turnAnchorPct = usedPct
    return
  }
  s.lastPct = usedPct
}

/**
 * A genuine user turn COMPLETED for this owner — record its whole-turn
 * context appetite as ONE observation. Ten model calls inside one turn are
 * one sample. Boundary notes with no meaningful growth (idle repaints,
 * cancelled-before-work) are ignored, keeping the honest-null warmup.
 */
export function noteCtxTurnBoundary(owner?: OwnerKey): void {
  const s = stateFor(owner)
  if (s.lastPct == null || s.turnAnchorPct == null) return
  const d = s.lastPct - s.turnAnchorPct
  if (d >= MIN_STEP) {
    s.deltas.push(d)
    if (s.deltas.length > GROWTH_SAMPLES) s.deltas.shift()
  }
  s.turnAnchorPct = s.lastPct
}

/** ≈turns until `compactAtPct`, from the owner's sampled growth rate.
 *  null = unknown (warmup / no growth observed / no threshold); 0 = at/over. */
export function estimateTurnsToCompact(
  currentPct: number | null,
  compactAtPct: number | null,
  owner?: OwnerKey,
): number | null {
  if (currentPct == null || compactAtPct == null) return null
  if (currentPct >= compactAtPct) return 0
  const s = stateFor(owner)
  if (s.deltas.length < 2) return null
  const avg = s.deltas.reduce((a, b) => a + b, 0) / s.deltas.length
  if (avg <= 0) return null
  return Math.ceil((compactAtPct - currentPct) / avg)
}

/** The owner's sampled per-turn context-appetite series (the SAME deltas the
 *  estimate averages — real growth steps, newest last; [] during warmup).
 *  Interaction-finish: the rail's ctx glance strip reads this; it
 *  renders nothing under two samples, matching the estimate's honest-null. */
export function ctxGrowthHistory(owner?: OwnerKey): readonly number[] {
  if (!ctxForecastEnabled()) return []
  return stateFor(owner).deltas
}

/** Test-only reset — drops EVERY owner's forecast state. */
export function resetCtxForecastForTest(): void {
  forecasts.clearAllForShutdown()
}
