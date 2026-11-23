import { useCallback, useRef } from 'react'
import { useClaim } from './effects.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'

export const DOUBLE_PRESS_TIMEOUT_MS = 800
export const EXIT_CHORD_WINDOW_MS = 3000

export function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void,
  windowMs = DOUBLE_PRESS_TIMEOUT_MS,
): () => void {
  const timer = useRef<NodeJS.Timeout | null>(null)
  useClaim(() => () => {
    if (timer.current !== null) {
      stopTimeout(timer.current)
      timer.current = null
    }
  }, [])
  return useCallback(() => {
    if (timer.current !== null) {
      stopTimeout(timer.current)
      timer.current = null
      setPending(false)
      onDoublePress()
      return
    }
    onFirstPress?.()
    setPending(true)
    timer.current = startTimeout(() => {
      timer.current = null
      setPending(false)
    }, windowMs)
  }, [setPending, onDoublePress, onFirstPress, windowMs])
}
