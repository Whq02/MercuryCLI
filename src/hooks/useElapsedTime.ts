
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
