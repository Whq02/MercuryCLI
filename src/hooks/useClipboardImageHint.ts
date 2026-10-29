
import { useEffect, useRef } from 'react'
import { useNotifications } from '../context/notifications.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { hasImageInClipboard } from '../utils/imagePaste.js'

const FOCUS_DEBOUNCE_MS = 1000
const HINT_COOLDOWN_MS = 30_000
const HINT_TIMEOUT_MS = 8000

export function useClipboardImageHint(
  isFocused: boolean,
  enabled: boolean,
): void {
  const { addNotification } = useNotifications()
  const addRef = useRef(addNotification)
  addRef.current = addNotification
  const pasteChord = useShortcutDisplay('chat:imagePaste', 'Chat', 'ctrl+v')
  const chordRef = useRef(pasteChord)
  chordRef.current = pasteChord
  const wasFocusedRef = useRef(isFocused)
  const lastShownRef = useRef(0)
  const pendingRef = useRef<NodeJS.Timeout | null>(null)
  const mountedRef = useRef(true)
  useEffect(
    () => () => {
      mountedRef.current = false
      if (pendingRef.current !== null) clearTimeout(pendingRef.current)
    },
    [],
  )

  useEffect(() => {
    const was = wasFocusedRef.current
    wasFocusedRef.current = isFocused
    if (!enabled || !isFocused || was) return
    if (pendingRef.current !== null) clearTimeout(pendingRef.current)
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null
      if (Date.now() - lastShownRef.current < HINT_COOLDOWN_MS) return
      void hasImageInClipboard()
        .then(has => {
          if (!mountedRef.current || !has) return
          lastShownRef.current = Date.now()
          addRef.current({
            key: 'clipboard-image-hint',
            text: `clipboard holds an image — ${chordRef.current} attaches it`,
            priority: 'immediate',
            timeoutMs: HINT_TIMEOUT_MS,
          })
        })
        .catch(() => {})
    }, FOCUS_DEBOUNCE_MS)
  }, [isFocused, enabled])
}
