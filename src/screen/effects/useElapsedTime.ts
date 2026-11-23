import { useCallback, useRef, useSyncExternalStore } from 'react'
import { formatDuration } from '../../platform/text/format.js'
import { lastClockTick, subscribeUiClock } from '../cockpit/uiClock.js'

const DEFAULT_CADENCE_MS = 1000

const noopSubscribe = (): (() => void) => () => {}

export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  ms: number = DEFAULT_CADENCE_MS,
  pausedMs: number = 0,
  endTime?: number | undefined,
): string {
  const frozenAtRef = useRef<number | null>(null)
  const active = endTime === undefined && isRunning

  const subscribe = useCallback(
    (listener: () => void) => subscribeUiClock(ms, listener),
    [ms],
  )
  const getSnapshot = useCallback(
    () => (active ? lastClockTick(ms) : 0),
    [active, ms],
  )
  const tickNow = useSyncExternalStore(
    active ? subscribe : noopSubscribe,
    getSnapshot,
    getSnapshot,
  )

  let now: number
  if (endTime !== undefined) {
    frozenAtRef.current = null
    now = endTime
  } else if (isRunning) {
    frozenAtRef.current = null
    now = tickNow
  } else {
    if (frozenAtRef.current === null) {
      frozenAtRef.current = Date.now()
    }
    now = frozenAtRef.current
  }

  return formatDuration(Math.max(0, now - startTime - pausedMs))
}
