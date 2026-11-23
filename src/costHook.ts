import { useRef } from 'react'
import { useClaim } from './hooks/effects.js'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { is1PApiCustomer } from './utils/auth.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  const getFpsMetricsRef = useRef(getFpsMetrics)
  getFpsMetricsRef.current = getFpsMetrics

  useClaim(() => {
    const onExit = (): void => {
      if (is1PApiCustomer()) {
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }
      saveCurrentSessionCosts(getFpsMetricsRef.current?.())
    }
    process.on('exit', onExit)
    return () => {
      process.off('exit', onExit)
    }
  }, [])
}
