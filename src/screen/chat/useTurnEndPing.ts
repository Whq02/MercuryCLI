import { useContext, useRef } from 'react'
import { useTimer } from '../effects/effects.js'
import { getLastInteractionTime } from '../../boot/process-state/processState.js'
import { getTerminalFocusState } from '../renderer/terminal-session/terminalFocusStore.js'
import { TerminalWriteContext } from '../renderer/terminalWrite.js'
import { postTerminalNotification } from '../renderer/termio/notifyPing.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export const DEFAULT_INTERACTION_THRESHOLD_MS = 6000
export const PING_MESSAGE = 'Mercury finished its turn and is waiting for you'

function hasRecentInteraction(threshold: number): boolean {
  return Date.now() - getLastInteractionTime() < threshold
}

export function isUserAtScreen(threshold: number): boolean {
  const focus = getTerminalFocusState()
  if (focus !== 'unknown') return focus === 'focused'
  return hasRecentInteraction(threshold)
}

export function pingEnabled(): boolean {
  return getInitialSettings().view?.ping !== false
}

interface TurnEndFacts {
  lastCompletedAt: number | null
  busy: boolean
}

export function useTurnEndPing(
  turn: TurnEndFacts,
  threshold: number = DEFAULT_INTERACTION_THRESHOLD_MS,
): void {
  const write = useContext(TerminalWriteContext)
  const busyRef = useRef(turn.busy)
  busyRef.current = turn.busy
  useTimer(() => {
    if (write === null || turn.lastCompletedAt === null) return
    const fire = (): void => {
      if (busyRef.current || isUserAtScreen(threshold) || !pingEnabled()) return
      postTerminalNotification(PING_MESSAGE, { write })
    }
    if (getTerminalFocusState() !== 'unknown') {
      fire()
      return
    }
    const timer = startTimeout(fire, threshold)
    timer.unref?.()
    return () => stopTimeout(timer)
  }, [write, turn.lastCompletedAt, threshold])
}
