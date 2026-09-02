// ============================================================================
//  messageCursorStore — the message-actions cursor's ONE owner.
//
//  The cursor used to live in the REPL's own React state, so every ↑/↓ in
//  cursor mode re-rendered the whole REPL tree before the transcript could
//  move its highlight: measured on a ~5,000-record session, one root render
//  per key (two at p95) beside the one transcript render that does the
//  work, two to three frames a key. The cursor now lives here, a module
//  store in the overlay-stack idiom: the transcript and the action bar
//  subscribe to the CURSOR, the REPL subscribes only to whether one is
//  ACTIVE (it swaps the composer for the bar and mounts the key handlers
//  on enter/exit) — a move re-renders the surfaces that paint it and
//  nothing above them.
//
//  React-free by design (useSyncExternalStore-compatible); the hooks below
//  are the only React face.
// ============================================================================

import { useSyncExternalStore } from 'react'
import type { MessageActionsState } from './messageActions.js'

let cursor: MessageActionsState | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* a throwing subscriber never blocks the others */
    }
  }
}

export function getMessageCursor(): MessageActionsState | null {
  return cursor
}

/** Whether a cursor stands — the one fact the REPL root subscribes to. */
export function isMessageCursorActive(): boolean {
  return cursor !== null
}

/** Move (or clear) the cursor. Setting the same object is a no-op — a
 *  subscriber never re-renders for a write that changed nothing. */
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

/** The live cursor — for the surfaces that paint it (the transcript, the
 *  action bar). Re-renders on every move. */
export function useMessageCursor(): MessageActionsState | null {
  return useSyncExternalStore(subscribeMessageCursor, getMessageCursor, getMessageCursor)
}

/** Whether a cursor stands — for the root that hosts the mode. Re-renders
 *  on enter and exit only, never on a move. */
export function useMessageCursorActive(): boolean {
  return useSyncExternalStore(subscribeMessageCursor, isMessageCursorActive, isMessageCursorActive)
}

/** Proof seam. */
export function _resetMessageCursorForTest(): void {
  cursor = null
  notify()
}
