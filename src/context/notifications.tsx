import type * as React from 'react'
import { useCallback } from 'react'
import { useMount } from '../hooks/effects.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Theme } from '../utils/theme.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt, unbuilt, type Unbuilt } from '../pi/holes.js'

export type Notification = Unbuilt

export const NOTICE_SEAM = ' · '

export function splitWayOut(line: string): { text: string; wayOut?: string } {
  const at = line.lastIndexOf(NOTICE_SEAM)
  if (at <= 0 || at + NOTICE_SEAM.length >= line.length) return { text: line }
  return { text: line.slice(0, at), wayOut: line.slice(at + NOTICE_SEAM.length) }
}

const DEFAULT_TIMEOUT_MS = 8000

export function standsUntilRemoved(entry: Notification): boolean {
  return entry.timeoutMs === Infinity
}

type SetAppState = (...args: Unbuilt[]) => Unbuilt

let expiryTimer: NodeJS.Timeout | null = unbuilt('src/context/notifications.tsx:66')

function cancelExpiry(): void {
  if (expiryTimer !== null) {
    stopTimeout(expiryTimer)
    expiryTimer = null
  }
}

export function enqueueNotification(
  setAppState: SetAppState,
  incoming: Notification,
): void {
  return notBuilt('src/context/notifications.tsx:107')
}

export function useNotifications(): {
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
} {
  return notBuilt('src/context/notifications.tsx:187')
}
