import { useRef } from 'react'
import { useClaim, useTimer } from '../effects/effects.js'
import { useNotifications } from '../notifications/notifications.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { hasImageInClipboard } from './imagePaste.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

const FOCUS_DEBOUNCE_MS = 1000
const HINT_COOLDOWN_MS = 30_000
const HINT_TIMEOUT_MS = 8000

export function useClipboardImageHint(
  isFocused: boolean,
  enabled: boolean,
): void {
  const { addNotification } = useNotifications()
  const chord = useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')
  const prevFocusedRef = useRef(isFocused)
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const lastShownRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const addNotificationRef = useRef(addNotification)
  addNotificationRef.current = addNotification
  const chordRef = useRef(chord)
  chordRef.current = chord

  useClaim(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timerRef.current !== null) {
        stopTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [])

  useTimer(() => {
    const wasFocused = prevFocusedRef.current
    prevFocusedRef.current = isFocused
    if (!enabled || wasFocused || !isFocused) return
    if (timerRef.current !== null) {
      stopTimeout(timerRef.current)
      timerRef.current = null
    }
    timerRef.current = startTimeout(() => {
      timerRef.current = null
      if (
        lastShownRef.current !== null &&
        Date.now() - lastShownRef.current < HINT_COOLDOWN_MS
      ) {
        return
      }
      void hasImageInClipboard()
        .then(hasImage => {
          if (!mountedRef.current || !hasImage) return
          lastShownRef.current = Date.now()
          addNotificationRef.current({
            key: 'clipboard-image-hint',
            text: `clipboard holds an image — ${chordRef.current} attaches it`,
            priority: 'immediate',
            timeoutMs: HINT_TIMEOUT_MS,
          })
        })
        .catch(passedOver)
    }, FOCUS_DEBOUNCE_MS)
  }, [isFocused, enabled])
}
