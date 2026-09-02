import { getIsInteractive } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getPerformance } from './profilerBase.js'
import { jsonStringify } from './slowOperations.js'

/**
 * Per-turn latency marks for print/headless mode. Active when the detailed
 * profiling variable is truthy or the process falls in a 5% random sample
 * decided once at module load — unsampled processes pay nothing.
 *
 * The checkpoint names are a cross-module contract; other slices call with
 * these exact strings: `turn_start`, `system_message_yielded`,
 * `query_started`, `first_chunk`, `api_request_sent`.
 */

const MARK_PREFIX = 'mercury_headless:'
// (No detailed-profile env arm exists; the 5% sampling arm remains.)
const sampled = Math.random() < 0.05
const active = sampled

let turnNumber = -1

function isEnabled(): boolean {
  return !getIsInteractive() && active
}

function clearMarks(): void {
  const perf = getPerformance()
  for (const mark of perf.getEntriesByType('mark')) {
    if (mark.name.startsWith(MARK_PREFIX)) perf.clearMarks(mark.name)
  }
}

export function headlessProfilerStartTurn(): void {
  if (!isEnabled()) return
  turnNumber++
  clearMarks()
  getPerformance().mark(`${MARK_PREFIX}turn_start`)
}

export function headlessProfilerCheckpoint(name: string): void {
  if (!isEnabled()) return
  getPerformance().mark(`${MARK_PREFIX}${name}`)
}

/**
 * Gather the prefixed marks, requiring a turn-start mark; compute the time
 * to the system message (turn 0 only, from process start — the performance
 * clock is process-relative), turn start → query start, turn start → first
 * chunk, and query start → API request sent. Under detailed profiling the
 * metadata is logged as JSON. (The sampled-only branch has no sink.)
 */
export function logHeadlessProfilerTurn(): void {
  if (!isEnabled()) return
  const perf = getPerformance()
  const marks = new Map<string, number>()
  for (const mark of perf.getEntriesByType('mark')) {
    if (mark.name.startsWith(MARK_PREFIX)) marks.set(mark.name.slice(MARK_PREFIX.length), mark.startTime)
  }
  const turnStart = marks.get('turn_start')
  if (turnStart === undefined) return
  const metadata: Record<string, unknown> = {
    turn: turnNumber,
    markCount: marks.size,
  }
  const systemMessage = marks.get('system_message_yielded')
  if (turnNumber === 0 && systemMessage !== undefined) {
    metadata.msToSystemMessage = Math.round(systemMessage)
  }
  const queryStart = marks.get('query_started')
  if (queryStart !== undefined) metadata.msToQueryStart = Math.round(queryStart - turnStart)
  const firstChunk = marks.get('first_chunk')
  if (firstChunk !== undefined) metadata.msToFirstChunk = Math.round(firstChunk - turnStart)
  const requestSent = marks.get('api_request_sent')
  if (queryStart !== undefined && requestSent !== undefined) {
    metadata.msQueryOverhead = Math.round(requestSent - queryStart)
  }
  if (process.env.MERCURY_ENTRYPOINT) metadata.entrypoint = process.env.MERCURY_ENTRYPOINT
}
