import React, { createContext } from 'react'
import { useClaim } from '../hooks/effects.js'
import { sessionSawUsage } from '../cost-tracker.js'
import { saveCurrentProjectConfig } from '../utils/config.js'
import { passedOver } from '../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../pi/holes.js'

const RESERVOIR_CAP = 1024

export type StatsStore = Unbuilt

export function createStatsStore(): StatsStore {
  return notBuilt('src/context/stats.tsx:36')
}

export function StatsProvider(arg0: {
  store?: StatsStore
  children: React.ReactNode
}): React.ReactNode {
  return notBuilt('src/context/stats.tsx:97')
}
