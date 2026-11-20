
import { useRef, useState } from 'react'
import { useTimer } from './effects.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'

export function useMinDisplayTime<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState(value)
  const shownAtRef = useRef(Date.now())
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  useTimer(() => {
    if (Object.is(value, shown)) return
    if (timerRef.current !== null) {
      stopTimeout(timerRef.current)
      timerRef.current = null
    }
    const elapsed = Date.now() - shownAtRef.current
    if (elapsed >= minMs) {
      shownAtRef.current = Date.now()
      setShown(value)
      return
    }
    timerRef.current = startTimeout(() => {
      timerRef.current = null
      shownAtRef.current = Date.now()
      setShown(value)
    }, minMs - elapsed)
    return () => {
      if (timerRef.current !== null) {
        stopTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [value, shown, minMs])

  return shown
}
