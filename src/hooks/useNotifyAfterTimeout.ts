// Desktop notification once the user is demonstrably away.
// Presence prefers the REAL terminal focus signal (DECSET 1004): a
// terminal that reports focused or blurred is trusted directly; only when
// focus is unreported does the recent-interaction window apply. The
// last-interaction timestamp is reset IMMEDIATELY on mount (not deferred
// to the render cycle) — a slow request finishing just as the hook mounts
// must not fire straight away, and with the user idle there are no
// further renders to flush a deferred reset. The repeating check fires at
// most once, then cancels itself. Interaction tracking itself lives in
// the input batch processor, deliberately not in a competing listener.

import { useEffect, useRef } from 'react'
import { getTerminalFocusState } from '../ink/session/focus-store.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import {
  getLastInteractionTime,
  updateLastInteractionTime,
} from '../bootstrap/state.js'

export const DEFAULT_INTERACTION_THRESHOLD_MS = 6000

function hasRecentInteraction(threshold: number): boolean {
  return Date.now() - getLastInteractionTime() < threshold
}

/** Present = focused when the terminal reports focus at all; the
 *  interaction window is the fallback ONLY for unknown focus. */
export function isUserActiveForNotifications(threshold: number): boolean {
  const focus = getTerminalFocusState()
  if (focus !== 'unknown') return focus === 'focused'
  return hasRecentInteraction(threshold)
}

export function useNotifyAfterTimeout(
  message: string,
  notificationType: string,
  threshold: number = DEFAULT_INTERACTION_THRESHOLD_MS,
): void {
  const terminal = useTerminalNotification()
  const terminalRef = useRef(terminal)
  terminalRef.current = terminal
  const messageRef = useRef(message)
  messageRef.current = message

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') return
    // Immediate, not render-deferred (see the header).
    updateLastInteractionTime(true)
    let fired = false
    const timer = setInterval(() => {
      if (fired) return
      if (!isUserActiveForNotifications(threshold)) {
        fired = true
        clearInterval(timer)
        void sendNotification(
          { message: messageRef.current, notificationType },
          terminalRef.current,
        )
      }
    }, threshold)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [notificationType, threshold])
}
