import { useSyncExternalStore } from 'react'
import {
  isTypingActive,
  subscribeTypingActivity,
} from '../cockpit/typingActivity.js'

export function useTypingPause(): boolean {
  return useSyncExternalStore(
    subscribeTypingActivity,
    isTypingActive,
    isTypingActive,
  )
}
