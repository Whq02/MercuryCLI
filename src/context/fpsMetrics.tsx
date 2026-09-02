// Publishes a getter for render-loop frame metrics. Consumers get
// undefined outside the provider — no throw.

import React, { createContext, useContext } from 'react'
import type { FpsMetrics } from '../utils/fpsTracker.js'

type FpsMetricsGetter = () => FpsMetrics | undefined

const FpsMetricsContext = createContext<FpsMetricsGetter | undefined>(undefined)

export function FpsMetricsProvider({
  getFpsMetrics,
  children,
}: {
  getFpsMetrics: FpsMetricsGetter
  children: React.ReactNode
}): React.ReactNode {
  return (
    <FpsMetricsContext.Provider value={getFpsMetrics}>
      {children}
    </FpsMetricsContext.Provider>
  )
}

export function useFpsMetrics(): FpsMetricsGetter | undefined {
  return useContext(FpsMetricsContext)
}
