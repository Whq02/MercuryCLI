import { useRef } from 'react'
import { useClaim, useTimer } from './effects.js'
import { useNotifications } from '../context/notifications.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { hasImageInClipboard } from '../utils/imagePaste.js'
import { passedOver } from '../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'

const FOCUS_DEBOUNCE_MS = 1000
const HINT_COOLDOWN_MS = 30_000
const HINT_TIMEOUT_MS = 8000

export function useClipboardImageHint(
  isFocused: boolean,
  enabled: boolean,
): void {
  return notBuilt('src/hooks/useClipboardImageHint.ts:14')
}
