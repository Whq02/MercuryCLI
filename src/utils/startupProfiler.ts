import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatMs, formatTimelineLine, getPerformance, type MemorySnapshot } from './profilerBase.js'


const detailed = process.env.MERCURY_PROFILE_STARTUP === '1'
const profilingOn = detailed

const TOTAL_PAD = 8
const DELTA_PAD = 7
const BANNER = '='.repeat(64)

const memorySnapshots: MemorySnapshot[] = []

let reported = false

export function profileCheckpoint(name: string): void {
  if (!profilingOn) return
  getPerformance().mark(name)
  if (detailed) {
    const usage = process.memoryUsage()
    memorySnapshots.push({ rss: usage.rss, heapUsed: usage.heapUsed })
  }
}

profileCheckpoint('profiler_initialized')

export function isDetailedProfilingEnabled(): boolean {
  return detailed
}

export function getStartupPerfLogPath(): string {
  return join(getMercuryHome(), 'startup-perf', `${getSessionId()}.txt`)
}

const PHASE_DEFINITIONS = {
  import_time: ['cli_entry', 'main_tsx_imports_loaded'],
  init_time: ['init_function_start', 'init_function_end'],
  settings_time: ['eagerLoadSettings_start', 'eagerLoadSettings_end'],
  total_time: ['cli_entry', 'main_after_run'],
} as const


function buildReport(): string {
  const marks = getPerformance().getEntriesByType('mark')
  const lines: string[] = [BANNER, 'STARTUP PROFILING REPORT', BANNER, '']
  if (!detailed) {
    lines.push('Detailed startup profiling is not enabled.')
  } else if (marks.length === 0) {
    lines.push('No checkpoints were recorded.')
  } else {
    let previous = 0
    marks.forEach((mark, index) => {
      lines.push(formatTimelineLine(mark.startTime, mark.startTime - previous, mark.name, memorySnapshots[index], TOTAL_PAD, DELTA_PAD))
      previous = mark.startTime
    })
    lines.push('')
    lines.push(`Total startup time: ${formatMs((marks[marks.length - 1] as PerformanceEntry).startTime)}ms`)
  }
  lines.push(BANNER)
  return lines.join('\n')
}

export function profileReport(): void {
  if (reported) return
  reported = true
  if (!detailed) return
  const report = buildReport()
  try {
    const path = getStartupPerfLogPath()
    mkdirSync(join(getMercuryHome(), 'startup-perf'), { recursive: true })
    writeFileSync(path, report, { flush: true })
  } catch {
  }
  logForDebugging('Startup profiling report:')
  logForDebugging(report)
}
