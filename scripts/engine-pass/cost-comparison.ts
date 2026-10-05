import assert from 'node:assert/strict'
import { median } from './support.ts'

export type Run = { metrics: Record<string, number> }

export function fiveRunMedians(runs: ReadonlyArray<Run>): Record<string, number> {
  assert.equal(runs.length, 5, 'five complete runs are required for each build')
  const keys = Object.keys(runs[0]!.metrics).sort()
  assert.ok(keys.length > 0, 'a measured metric set is required')
  for (const run of runs) {
    assert.deepEqual(Object.keys(run.metrics).sort(), keys, 'every run must carry every metric')
    for (const value of Object.values(run.metrics)) assert.ok(Number.isFinite(value) && value >= 0, 'invalid measured value')
  }
  return Object.fromEntries(keys.map(key => [key, median(runs.map(run => run.metrics[key]!))]))
}

export const isTiming = (metric: string): boolean => metric.endsWith('Ms')

export function trimmedSpread(values: readonly number[]): number {
  assert.equal(values.length, 5, 'the spread is read over five runs')
  const sorted = values.toSorted((a, b) => a - b)
  return sorted[3]! - sorted[1]!
}

export function timingNoise(...sides: ReadonlyArray<ReadonlyArray<Run>>): Record<string, number> {
  const noise: Record<string, number> = {}
  for (const side of sides) {
    const medians = fiveRunMedians(side)
    for (const metric of Object.keys(medians)) {
      if (!isTiming(metric)) continue
      const spread = trimmedSpread(side.map(run => run.metrics[metric]!))
      noise[metric] = Math.max(noise[metric] ?? 0, spread)
    }
  }
  return noise
}

export function costRows(base: Record<string, number>, tip: Record<string, number>, noise: Record<string, number> = {}): Array<{ metric: string; base: number; tip: number; floor: number; pass: boolean }> {
  assert.deepEqual(Object.keys(tip).sort(), Object.keys(base).sort(), 'base and tip must measure the same metrics')
  assert.ok(Object.keys(base).length > 0, 'no empty comparison')
  return Object.keys(base).sort().map(metric => {
    const before = base[metric]!
    const after = tip[metric]!
    assert.ok(Number.isFinite(before) && before >= 0 && Number.isFinite(after) && after >= 0, 'invalid comparison value')
    const floor = isTiming(metric) ? noise[metric] ?? 0 : 0
    assert.ok(Number.isFinite(floor) && floor >= 0, 'invalid noise floor')
    return { metric, base: before, tip: after, floor, pass: after <= before + floor }
  })
}
