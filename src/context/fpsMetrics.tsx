import React, { createContext, useContext } from 'react'
import type { FpsMetrics } from '../utils/fpsTracker.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

type FpsMetricsGetter = (...args: Unbuilt[]) => Unbuilt

export function FpsMetricsProvider(arg0: {
  getFpsMetrics: FpsMetricsGetter
  children: React.ReactNode
}): React.ReactNode {
  return notBuilt('src/context/fpsMetrics.tsx:9')
}

export function useFpsMetrics(): FpsMetricsGetter | undefined {
  return notBuilt('src/context/fpsMetrics.tsx:23')
}
