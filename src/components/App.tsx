
import React from 'react'
import { FpsMetricsProvider } from '../context/fpsMetrics.js'
import { StatsProvider, type StatsStore } from '../context/stats.js'
import { AppStateProvider } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'

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
        <AppStateProvider
          initialState={initialState}
          onChangeAppState={onChangeAppState}
        >
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}

export default App
