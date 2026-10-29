
import { useCallback, useEffect, useRef } from 'react'

export const DOUBLE_PRESS_TIMEOUT_MS = 800

export const EXIT_CHORD_WINDOW_MS = 3000

export function useDoublePress(
  setPending: (pending: boolean) => void,
  onDoublePress: () => void,
  onFirstPress?: () => void,
  windowMs: number = DOUBLE_PRESS_TIMEOUT_MS,
): () => void {
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current)
    },
    [],
  )
  return useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      setPending(false)
      onDoublePress()
      return
    }
    onFirstPress?.()
    setPending(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setPending(false)
    }, windowMs)
  }, [setPending, onDoublePress, onFirstPress, windowMs])
}
