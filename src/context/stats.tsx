// In-memory counters / gauges / histograms / sets, flushed to the
// project configuration at process exit together with a window descriptor,
// so the numbers are never confused with session-cumulative cost counters.
// Histograms keep count/sum/min/max plus a 1024-value reservoir sample.
// The four bound writer hooks of the base build have no callers and are
// NOT built (drop-dead ruling item 6).

import React, { createContext, useContext, useEffect } from 'react'
import { sessionSawUsage } from '../cost-tracker.js'
import { saveCurrentProjectConfig } from '../utils/config.js'

const RESERVOIR_CAP = 1024

export type StatsStore = {
  increment: (name: string, value?: number) => void
  set: (name: string, value: number) => void
  observe: (name: string, value: number) => void
  add: (name: string, value: string) => void
  getAll: () => Record<string, number>
}

type Histogram = {
  count: number
  sum: number
  min: number
  max: number
  reservoir: number[]
}

/** Linear interpolation over a SORTED sample; the exact-index case must not
 *  interpolate. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0] as number
  const rank = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sorted[lo] as number
  const weight = rank - lo
  return (sorted[lo] as number) * (1 - weight) + (sorted[hi] as number) * weight
}

export function createStatsStore(): StatsStore {
  const counters = new Map<string, number>()
  const gauges = new Map<string, number>()
  const histograms = new Map<string, Histogram>()
  const sets = new Map<string, Set<string>>()

  return {
    increment(name, value = 1) {
      counters.set(name, (counters.get(name) ?? 0) + value)
    },
    set(name, value) {
      gauges.set(name, value)
    },
    observe(name, value) {
      let hist = histograms.get(name)
      if (!hist) {
        hist = { count: 0, sum: 0, min: Infinity, max: -Infinity, reservoir: [] }
        histograms.set(name, hist)
      }
      hist.count++
      hist.sum += value
      hist.min = Math.min(hist.min, value)
      hist.max = Math.max(hist.max, value)
      // Classic reservoir sampling: fill until full, then replace a
      // uniformly chosen slot when the chosen index falls inside.
      if (hist.reservoir.length < RESERVOIR_CAP) {
        hist.reservoir.push(value)
      } else {
        const slot = Math.floor(Math.random() * hist.count)
        if (slot < RESERVOIR_CAP) hist.reservoir[slot] = value
      }
    },
    add(name, value) {
      let set = sets.get(name)
      if (!set) {
        set = new Set()
        sets.set(name, set)
      }
      set.add(value)
    },
    getAll() {
      const out: Record<string, number> = {}
      for (const [name, value] of counters) out[name] = value
      for (const [name, value] of gauges) out[name] = value
      for (const [name, set] of sets) out[name] = set.size
      for (const [name, hist] of histograms) {
        if (hist.count === 0) continue
        const sorted = [...hist.reservoir].sort((a, b) => a - b)
        out[`${name}_count`] = hist.count
        out[`${name}_min`] = hist.min
        out[`${name}_max`] = hist.max
        out[`${name}_avg`] = hist.sum / hist.count
        out[`${name}_p50`] = percentile(sorted, 50)
        out[`${name}_p95`] = percentile(sorted, 95)
        out[`${name}_p99`] = percentile(sorted, 99)
      }
      return out
    },
  }
}

export const StatsContext = createContext<StatsStore | null>(null)

export function StatsProvider({
  store,
  children,
}: {
  store?: StatsStore
  children: React.ReactNode
}): React.ReactNode {
  const [owned] = React.useState(() => store ?? createStatsStore())
  const live = store ?? owned

  // Process-exit flush: the non-empty metric record lands in the project
  // config together with the window descriptor marking one process leg.
  useEffect(() => {
    const flush = (): void => {
      // A per-project row is written only for a project this process
      // actually worked in (the folder-as-project law): a boot that only
      // looked at the menu leaves no metrics under the folder.
      if (!sessionSawUsage()) return
      const metrics = live.getAll()
      if (Object.keys(metrics).length === 0) return
      try {
        saveCurrentProjectConfig(current => ({
          ...current,
          lastSessionMetrics: metrics,
          lastSessionMetricsWindow: {
            kind: 'process-leg',
            pid: process.pid,
            savedAtMs: Date.now(),
          },
        }))
      } catch {
        /* exit-path flush is best-effort */
      }
    }
    process.on('exit', flush)
    return () => {
      process.off('exit', flush)
    }
  }, [live])

  return <StatsContext.Provider value={live}>{children}</StatsContext.Provider>
}

export function useStats(): StatsStore {
  const store = useContext(StatsContext)
  if (store === null) {
    throw new Error('useStats must be used within a StatsProvider')
  }
  return store
}
