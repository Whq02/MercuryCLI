import { useRef, useState } from 'react'
import { useTimer } from './effects.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'

export function useMinDisplayTime<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState<T>(() => value)
  const [initialShownAt] = useState<number>(() => Date.now())
  const shownAtRef = useRef<number>(initialShownAt)

  useTimer(() => {
    if (Object.is(value, shown)) return
    const now = Date.now()
    const elapsed = now - shownAtRef.current
    if (elapsed >= minMs) {
      shownAtRef.current = now
      setShown(() => value)
      return
    }
    const timer = startTimeout(() => {
      shownAtRef.current = Date.now()
      setShown(() => value)
    }, minMs - elapsed)
    return () => {
      stopTimeout(timer)
    }
  }, [value, shown, minMs])

  return shown
}
