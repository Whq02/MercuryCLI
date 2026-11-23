import { useRef } from 'react'
import { useClaim } from '../../screen/effects/effects.js'
import { formatTotalCost, saveCurrentSessionCosts } from './sessionCost.js'
import { is1PApiCustomer } from '../sign-in/credentials/auth.js'
import type { FpsMetrics } from '../../screen/frame-rate/fpsTracker.js'

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
