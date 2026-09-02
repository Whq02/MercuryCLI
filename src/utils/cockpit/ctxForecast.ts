
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { registerOwnerScopedStore } from '../../services/run/ownerLifecycle.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function ctxForecastEnabled(): boolean {
  if (flagEnv('MERCURY_CTX_FORECAST') === '0') return false
  return true
}

const GROWTH_SAMPLES = 8
const MIN_STEP = 0.1
const RESET_DROP = 5

interface ForecastState {
  deltas: number[]
  lastPct: number | null
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

export function recordCtxSample(usedPct: number | null, owner?: OwnerKey): void {
  if (usedPct == null) return
  const s = stateFor(owner)
  if (s.lastPct == null) {
    s.lastPct = usedPct
    s.turnAnchorPct = usedPct
    return
  }
  const d = usedPct - s.lastPct
  if (d <= -RESET_DROP) {
    s.deltas.length = 0
    s.lastPct = usedPct
    s.turnAnchorPct = usedPct
    return
  }
  s.lastPct = usedPct
}

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

export function ctxGrowthHistory(owner?: OwnerKey): readonly number[] {
  if (!ctxForecastEnabled()) return []
  return stateFor(owner).deltas
}

export function resetCtxForecastForTest(): void {
  forecasts.clearAllForShutdown()
}
