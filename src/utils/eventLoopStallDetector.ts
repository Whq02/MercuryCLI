// Main-thread stall watchdog.
//
// A 200ms setInterval measures wall-clock drift since its previous tick; any
// drift beyond the expected interval is time the event loop was blocked.
// Stalls past STALL_THRESHOLD_MS are logged with running totals plus an
// RSS/heap sample taken at that moment. A very large drift (> LIKELY_SLEEP_MS)
// almost always means the machine suspended and resumed rather than that JS
// blocked — and a laptop wake scrambles tty state (raw mode, alt-screen,
// mouse tracking), which a fullscreen TUI cannot shrug off. That case triggers
// a terminal-mode reassert on the stdout renderer. The interval is unref()'d
// so the watchdog never holds the process open.

import instances from '../ink/instances.js'
import { logForDebugging } from './debug.js'

const DETECT_INTERVAL_MS = 200 // how often the watchdog samples
const STALL_THRESHOLD_MS = 500 // smaller drifts pass unreported
const LIKELY_SLEEP_MS = 5000 // past this, suspect suspend/resume, not JS

let watchdog: ReturnType<typeof setInterval> | null = null
let previousTickAt = 0 // wall-clock of the prior tick
let stallsObserved = 0 // total stalls so far
let stalledMsTotal = 0 // sum of all stall durations
let ticksObserved = 0 // total ticks, stalled or not

export type MemorySample = {
  rss_mb: number
  heap_used_mb: number
  ext_mb: number
}

/**
 * Snapshot process memory (MB, rounded). Returns null — and logs at error
 * level — if process.memoryUsage() itself throws.
 */
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

/**
 * Start the stall watchdog. Idempotent — a second call while running is a
 * no-op. Each tick compares actual elapsed time against the expected
 * interval; drift past STALL_THRESHOLD_MS is counted and logged with a
 * memory sample, and drift past LIKELY_SLEEP_MS additionally reasserts
 * terminal modes on stdout (including the alt screen — this watchdog is the
 * one caller with a signal strong enough to justify that re-entry).
 */
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

      // The alt-screen wake heal (a PAIRED ?1049l+h with a scheduled
      // repaint — never the bare repeat the estate forbids) is passed here
      // and nowhere else: only a wake-from-sleep signal is strong enough
      // to justify touching the screen session at all.
      if (suspectSleep) {
        instances.get(process.stdout)?.reassertTerminalModes(true)
      }
    }

    previousTickAt = tickAt
  }

  watchdog = setInterval(onTick, DETECT_INTERVAL_MS)
  watchdog.unref()
}
