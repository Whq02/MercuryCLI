import { useRef, useSyncExternalStore } from 'react'
import { formatDuration } from '../utils/format.js'
import { lastClockTick, subscribeUiClock } from '../utils/cockpit/uiClock.js'
import { notBuilt } from '../pi/holes.js'

const DEFAULT_CADENCE_MS = 1000

const noopSubscribe = (): (() => void) => () => {}

export function useElapsedTime(
  startTime: number,
  isRunning: boolean,
  ms?: number,
  pausedMs?: number,
  endTime?: number | undefined,
): string {
  return notBuilt('src/hooks/useElapsedTime.ts:10')
}
