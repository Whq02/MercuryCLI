
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
