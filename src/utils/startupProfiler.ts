import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getSessionId } from '../bootstrap/state.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { logForDebugging } from './debug.js'
import { getMercuryHome } from './envUtils.js'
import { passedOver } from './passedOver.js'
import { formatMs, formatTimelineLine, getPerformance, type MemorySnapshot } from './profilerBase.js'

const DETAILED_PROFILING = flagEnv('MERCURY_PROFILE_STARTUP') === '1'
const BANNER = '='.repeat(64)
const memorySnapshots: MemorySnapshot[] = []
let reported = false

profileCheckpoint('profiler_initialized')

export function profileCheckpoint(name: string): void {
  if (!DETAILED_PROFILING) return
  getPerformance().mark(name)
  const { rss, heapUsed } = process.memoryUsage()
  memorySnapshots.push({ rss, heapUsed })
}

export function isDetailedProfilingEnabled(): boolean {
  return DETAILED_PROFILING
}

export function getStartupPerfLogPath(): string {
  return join(getMercuryHome(), 'startup-perf', `${getSessionId()}.txt`)
}

function reportText(): string {
  const marks = getPerformance().getEntriesByType('mark')
  const lines = [BANNER, 'STARTUP PROFILING REPORT', BANNER, '']
  if (marks.length === 0) {
    lines.push('No checkpoints were recorded.')
  } else {
    let before = 0
    for (const [index, mark] of marks.entries()) {
      lines.push(formatTimelineLine(mark.startTime, mark.startTime - before, mark.name, memorySnapshots[index], 8, 7))
      before = mark.startTime
    }
    lines.push('', `Total startup time: ${formatMs(before)}ms`)
  }
  lines.push(BANNER)
  return lines.join('\n')
}

export function profileReport(): void {
  if (reported) return
  reported = true
  if (!DETAILED_PROFILING) return
  const report = reportText()
  const path = getStartupPerfLogPath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, report, { encoding: 'utf8', flush: true })
  } catch (error) {
    passedOver(error)
  }
  logForDebugging('Startup profiling report:')
  logForDebugging(report)
}
