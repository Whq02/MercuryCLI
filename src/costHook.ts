import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { is1PApiCustomer } from './utils/auth.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
