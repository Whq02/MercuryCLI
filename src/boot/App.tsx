import React from 'react'
import { FpsMetricsProvider } from '../screen/frame-rate/fpsMetrics.js'
import { StatsProvider, type StatsStore } from '../platform/observability/stats.js'
import { AppStateProvider } from '../screen/app-state/AppState.js'
import type { AppState } from '../screen/app-state/AppStateStore.js'
import type { FpsMetrics } from '../screen/frame-rate/fpsTracker.js'

export function App({
  getFpsMetrics,
  stats,
  initialState,
  children,
}: {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
  children: React.ReactNode
}): React.ReactNode {
  return (
    <FpsMetricsProvider getFpsMetrics={getFpsMetrics}>
      <StatsProvider store={stats}>
        <AppStateProvider initialState={initialState}>{children}</AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}

export default App
