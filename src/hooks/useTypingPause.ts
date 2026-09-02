import { useSyncExternalStore } from 'react'
import {
  isTypingActive,
  subscribeTypingActivity,
} from '../utils/cockpit/typingActivity.js'

/**
 * useTypingPause — true while the operator is actively typing (within
 * TYPING_HOLD_MS of the last composer keystroke). DECOR-tier motion
 * (ReadyBreath · TwinkleSpark) consumes this to pause; TRUTH-tier
 * indicators never do (the liveGlyphs motion hierarchy).
 */
export function useTypingPause(): boolean {
  return useSyncExternalStore(
    subscribeTypingActivity,
    isTypingActive,
    isTypingActive,
  )
}
