import { useSubscription } from './hooks/effects.js'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { is1PApiCustomer } from './utils/auth.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useSubscription(() => {
    const onExit = (): void => {
      if (is1PApiCustomer()) {
        process.stdout.write(`\n${formatTotalCost()}\n`)
      }
      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    process.on('exit', onExit)
    return () => {
      process.off('exit', onExit)
    }
  }, [])
}
