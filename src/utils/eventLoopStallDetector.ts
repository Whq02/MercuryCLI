
import instances from '../ink/instances.js'
import { logForDebugging } from './debug.js'

const DETECT_INTERVAL_MS = 200
const STALL_THRESHOLD_MS = 500
const LIKELY_SLEEP_MS = 5000

let watchdog: ReturnType<typeof setInterval> | null = null
let previousTickAt = 0
let stallsObserved = 0
let stalledMsTotal = 0
let ticksObserved = 0

export type MemorySample = {
  rss_mb: number
  heap_used_mb: number
  ext_mb: number
}

export function sampleRss(): MemorySample | null {
  let usage: ReturnType<typeof process.memoryUsage>
  try {
    usage = process.memoryUsage()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    logForDebugging(`[event-loop-stall] process.memoryUsage() failed: ${detail}`, {
      level: 'error',
    })
    return null
  }
  const asMb = (bytes: number) => Math.round(bytes / 1024 / 1024)
  return {
    rss_mb: asMb(usage.rss),
    heap_used_mb: asMb(usage.heapUsed),
    ext_mb: asMb(usage.external),
  }
}

export function startEventLoopStallDetector(): void {
  if (watchdog !== null) return

  previousTickAt = Date.now()
  logForDebugging(
    `[event-loop-stall] detector started (interval=${DETECT_INTERVAL_MS}ms, threshold=${STALL_THRESHOLD_MS}ms)`,
  )

  const onTick = () => {
    const tickAt = Date.now()
    const actual = tickAt - previousTickAt
    const stall = actual - DETECT_INTERVAL_MS
    ticksObserved++

    if (stall > STALL_THRESHOLD_MS) {
      stallsObserved++
      stalledMsTotal += stall
      const suspectSleep = stall > LIKELY_SLEEP_MS
      const mem = sampleRss()

      let line =
        `[event-loop-stall] blocked for ${stall}ms ` +
        `(expected ${DETECT_INTERVAL_MS}ms, actual ${actual}ms). ` +
        `Total stalls: ${stallsObserved}, cumulative: ${stalledMsTotal}ms`
      if (suspectSleep) line += ' [likely sleep/wake]'
      if (mem !== null) {
        line += ` rss=${mem.rss_mb}MB heap=${mem.heap_used_mb}MB ext=${mem.ext_mb}MB`
      }
      logForDebugging(line, { level: 'warn' })

      if (suspectSleep) {
        instances.get(process.stdout)?.reassertTerminalModes(true)
      }
    }

    previousTickAt = tickAt
  }

  watchdog = setInterval(onTick, DETECT_INTERVAL_MS)
  watchdog.unref()
}
