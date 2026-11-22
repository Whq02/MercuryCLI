import React from 'react'
import type { StatsStore } from '../context/stats.js'
import type { AppState } from '../state/AppStateStore.js'
import type { FpsMetrics } from '../utils/fpsTracker.js'
import { notBuilt } from '../pi/holes.js'

export function App(arg0: {
  getFpsMetrics: () => FpsMetrics | undefined
  stats?: StatsStore
  initialState: AppState
  children: React.ReactNode
}): React.ReactNode {
  return notBuilt('src/components/App.tsx:9')
}

export default App
