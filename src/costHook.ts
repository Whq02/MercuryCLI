import { useClaim } from './hooks/effects.js'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { is1PApiCustomer } from './utils/auth.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { notBuilt } from './pi/holes.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  return notBuilt('src/costHook.ts:6')
}
