import React, { createContext } from 'react'
import { useClaim } from '../hooks/effects.js'
import { sessionSawUsage } from '../cost-tracker.js'
import { saveCurrentProjectConfig } from '../utils/config.js'
import { passedOver } from '../utils/passedOver.js'

const RESERVOIR_CAP = 1024

export type StatsStore = {
  increment: (name: string, amount?: number) => void
  set: (name: string, value: number) => void
  observe: (name: string, value: number) => void
  add: (name: string, value: string) => void
  getAll: () => Record<string, number>
}

type Histogram = { count: number; sum: number; min: number; max: number; sample: number[] }

function percentile(sorted: number[], fraction: number): number {
  const rank = fraction * (sorted.length - 1)
  const low = Math.floor(rank)
  if (low === rank) return sorted[low]!
  const part = rank - low
  return sorted[low]! * (1 - part) + sorted[low + 1]! * part
}

export function createStatsStore(): StatsStore {
  const counters = new Map<string, number>()
  const gauges = new Map<string, number>()
  const sets = new Map<string, Set<string>>()
  const histograms = new Map<string, Histogram>()
  return {
    increment(name, amount = 1) {
      counters.set(name, (counters.get(name) ?? 0) + amount)
    },
    set(name, value) {
      gauges.set(name, value)
    },
    observe(name, value) {
      let histogram = histograms.get(name)
      if (!histogram) {
        histogram = { count: 0, sum: 0, min: value, max: value, sample: [] }
        histograms.set(name, histogram)
      }
      histogram.count++
      histogram.sum += value
      histogram.min = Math.min(histogram.min, value)
      histogram.max = Math.max(histogram.max, value)
      if (histogram.sample.length < RESERVOIR_CAP) histogram.sample.push(value)
      else {
        const slot = Math.floor(Math.random() * histogram.count)
        if (slot < RESERVOIR_CAP) histogram.sample[slot] = value
      }
    },
    add(name, value) {
      const set = sets.get(name)
      if (set) set.add(value)
      else sets.set(name, new Set([value]))
    },
    getAll() {
      const rows = new Map(counters)
      for (const [name, value] of gauges) rows.set(name, value)
      for (const [name, set] of sets) rows.set(name, set.size)
      for (const [name, histogram] of histograms) {
        const sorted = [...histogram.sample].sort((a, b) => a - b)
        rows.set(`${name}_count`, histogram.count)
        rows.set(`${name}_min`, histogram.min)
        rows.set(`${name}_max`, histogram.max)
        rows.set(`${name}_avg`, histogram.sum / histogram.count)
        rows.set(`${name}_p50`, percentile(sorted, 0.5))
        rows.set(`${name}_p95`, percentile(sorted, 0.95))
        rows.set(`${name}_p99`, percentile(sorted, 0.99))
      }
      return Object.fromEntries(rows)
    },
  }
}

const StatsContext = createContext<StatsStore | null>(null)

export function StatsProvider({ store, children }: { store?: StatsStore; children: React.ReactNode }): React.ReactNode {
  const [initial] = React.useState(() => store ?? createStatsStore())
  const live = store ?? initial
  useClaim(() => {
    const save = () => {
      if (!sessionSawUsage()) return
      const metrics = live.getAll()
      if (!Object.keys(metrics).length) return
      try {
        saveCurrentProjectConfig(current => ({
          ...current,
          lastSessionMetrics: metrics,
          lastSessionMetricsWindow: { kind: 'process-leg', pid: process.pid, savedAtMs: Date.now() },
        }))
      } catch (error) {
        passedOver(error)
      }
    }
    process.on('exit', save)
    return () => { process.off('exit', save) }
  }, [live])
  return <StatsContext.Provider value={live}>{children}</StatsContext.Provider>
}
