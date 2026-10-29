
import { useSyncExternalStore } from 'react'
import type { MessageActionsState } from './messageActions.js'

let cursor: MessageActionsState | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
    }
  }
}

export function getMessageCursor(): MessageActionsState | null {
  return cursor
}

export function isMessageCursorActive(): boolean {
  return cursor !== null
}

export function setMessageCursor(next: MessageActionsState | null): void {
  if (next === cursor) return
  cursor = next
  notify()
}

export function subscribeMessageCursor(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useMessageCursor(): MessageActionsState | null {
  return useSyncExternalStore(subscribeMessageCursor, getMessageCursor, getMessageCursor)
}

export function useMessageCursorActive(): boolean {
  return useSyncExternalStore(subscribeMessageCursor, isMessageCursorActive, isMessageCursorActive)
}

export function _resetMessageCursorForTest(): void {
  cursor = null
  notify()
}
