// ============================================================================
//  src/costHook.ts — on process exit, print the cost summary (for accounts
//  with console billing) and persist the session costs.
// ============================================================================
import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { is1PApiCustomer } from './utils/auth.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  // Registered once for the component's lifetime even though the getter is a
  // parameter — the exit listener reads it late, at exit time.
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
