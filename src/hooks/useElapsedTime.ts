// Formatted elapsed duration on the shared quantised UI clock.
// Value = end − start − paused, floored at zero: an explicit end freezes
// terminal work; running derives from the clock's LAST NOTIFIED tick (two
// same-render reads can never disagree); not-running-and-unfrozen serves a
// FROZEN capture, because an unsubscribed external-store snapshot must
// return the same value on every read. A private per-row interval is the
// defect class this rides over: one shared bucket per cadence.

import { useRef, useSyncExternalStore } from 'react'
import { formatDuration } from '../utils/format.js'
import { lastClockTick, subscribeUiClock } from '../utils/cockpit/uiClock.js'

const DEFAULT_CADENCE_MS = 1000

const noopSubscribe = (): (() => void) => () => {}

export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  ms: number = DEFAULT_CADENCE_MS,
  pausedMs: number = 0,
  endTime?: number | undefined,
): string {
  // The frozen capture for the not-running-and-unfrozen state: captured on
  // the first such read and held until running resumes.
  const frozenRef = useRef<number | null>(null)
  if (isRunning || endTime !== undefined) frozenRef.current = null

  const snapshot = (): string => {
    let end: number
    if (endTime !== undefined) {
      end = endTime
    } else if (isRunning) {
      end = lastClockTick(ms)
    } else {
      if (frozenRef.current === null) frozenRef.current = Date.now()
      end = frozenRef.current
    }
    return formatDuration(Math.max(0, end - startTime - pausedMs), {
      mostSignificantOnly: true,
    })
  }

  return useSyncExternalStore(
    isRunning
      ? (notify: () => void) => {
          return subscribeUiClock(ms, notify)
        }
      : noopSubscribe,
    snapshot,
    snapshot,
  )
}
