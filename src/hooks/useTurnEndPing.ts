import { useContext, useEffect, useRef } from 'react'
import { getLastInteractionTime } from '../bootstrap/state.js'
import { getTerminalFocusState } from '../ink/session/focus-store.js'
import { TerminalWriteContext } from '../ink/terminalWrite.js'
import { postTerminalNotification } from '../ink/termio/notifyPing.js'
import { getInitialSettings } from '../utils/settings/settings.js'

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

export interface TurnEndFacts {
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
  useEffect(() => {
    if (write === null || turn.lastCompletedAt === null) return
    const fire = (): void => {
      if (busyRef.current || isUserAtScreen(threshold) || !pingEnabled()) return
      postTerminalNotification(PING_MESSAGE, { write })
    }
    if (getTerminalFocusState() !== 'unknown') {
      fire()
      return
    }
    const timer = setTimeout(fire, threshold)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, [write, turn.lastCompletedAt, threshold])
}
