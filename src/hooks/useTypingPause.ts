import { useSyncExternalStore } from 'react'
import {
  isTypingActive,
  subscribeTypingActivity,
} from '../utils/cockpit/typingActivity.js'

export function useTypingPause(): boolean {
  return useSyncExternalStore(
    subscribeTypingActivity,
    isTypingActive,
    isTypingActive,
  )
}
