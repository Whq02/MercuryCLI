// Two-press-within-a-window gesture primitive. A press is a double
// press when it lands within the window AND a pending timer exists; a first
// press fires the optional first-press callback, sets pending, and arms the
// window timer. The timer clears on unmount. The window is caller-set:
// Esc's double-tap keeps the tight default; the exit chords ride the wider
// EXIT_CHORD_WINDOW_MS (operator ruling — a quit gesture gets a calm 3 s,
// distinct from the 800 ms editing rhythm).

import { useCallback, useEffect, useRef } from 'react'

export const DOUBLE_PRESS_TIMEOUT_MS = 800

/** The ctrl+c / ctrl+d exit chords' own window (the exit grammar:
 * arm → a second press inside 3 s closes; the pending state
 *  (and its notice) clears when the window lapses. */
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
