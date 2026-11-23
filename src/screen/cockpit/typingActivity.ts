import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export const TYPING_HOLD_MS = 1400

let typingActive = false
let holdTimer: ReturnType<typeof setTimeout> | null = null
const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

export function markTypingActivity(): void {
  if (holdTimer) stopTimeout(holdTimer)
  holdTimer = startTimeout(() => {
    holdTimer = null
    if (typingActive) {
      typingActive = false
      notify()
    }
  }, TYPING_HOLD_MS)
  holdTimer.unref?.()
  if (!typingActive) {
    typingActive = true
    notify()
  }
}

export function isTypingActive(): boolean {
  return typingActive
}

export function subscribeTypingActivity(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function __typingActivityResetForTest(): void {
  if (holdTimer) stopTimeout(holdTimer)
  holdTimer = null
  typingActive = false
}
