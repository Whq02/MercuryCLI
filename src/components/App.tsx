
import React, { useEffect, useRef } from 'react'
import { FpsMetricsProvider } from '../context/fpsMetrics.js'
import { StatsProvider, type StatsStore } from '../context/stats.js'
import { AppStateProvider, useAppStateStore } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'
import {
  getBootRecovery,
  subscribeBootRecovery,
} from '../substrate/recoveryOrchestrator.js'

function LateBootProjectionSeed(): React.ReactNode {
  const store = useAppStateStore()
  const appliedRef = useRef(false)

  useEffect(() => {
    const applyIfSettled = (): boolean => {
      const s = getBootRecovery()
      if (s.phase !== 'done') return false
      const projection = s.report?.leaderProjection ?? null
      if (projection && !appliedRef.current) {
        appliedRef.current = true
        store.setState((prev: AppState) =>
          prev.teamContext ? prev : {
            ...prev,
            teamContext: {
              teamName: projection.teamName,
              teamFilePath: projection.teamFilePath,
              leadAgentId: projection.leadAgentId,
              teammates: projection.teammates,
            },
          },
        )
      }
      return true
    }

    if (applyIfSettled()) return
    const unsubscribe = subscribeBootRecovery(() => {
      if (applyIfSettled()) unsubscribe()
    })
    return unsubscribe
  }, [store])

  return null
}

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
        ><LateBootProjectionSeed />
          {children}
        </AppStateProvider>
      </StatsProvider>
    </FpsMetricsProvider>
  )
}

export default App
