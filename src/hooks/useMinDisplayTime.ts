// Guarantees each distinct value a minimum on-screen dwell —
// neither a debounce nor a throttle: it does not wait for input to settle
// and does not cap the rate; it guarantees each value a minimum time.

import { useEffect, useRef, useState } from 'react'

export function useMinDisplayTime<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState(value)
  const shownAtRef = useRef(Date.now())
  const timerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    if (Object.is(value, shown)) return
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const elapsed = Date.now() - shownAtRef.current
    if (elapsed >= minMs) {
      shownAtRef.current = Date.now()
      setShown(value)
      return
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      shownAtRef.current = Date.now()
      setShown(value)
    }, minMs - elapsed)
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [value, shown, minMs])

  return shown
}
