import { getIsInteractive } from '../bootstrap/state.js'
import { getPerformance } from './profilerBase.js'

const sampled = Math.random() < 0.05
let turnNumber = -1

export function headlessProfilerStartTurn(): void {
  if (!sampled || getIsInteractive()) return
  turnNumber++
  const perf = getPerformance()
  for (const mark of perf.getEntriesByType('mark')) {
    if (mark.name.startsWith('mercury_headless:')) perf.clearMarks(mark.name)
  }
  perf.mark('mercury_headless:turn_start')
}

export function headlessProfilerCheckpoint(name: string): void {
  if (sampled && !getIsInteractive()) getPerformance().mark(`mercury_headless:${name}`)
}

export function logHeadlessProfilerTurn(): void {}
