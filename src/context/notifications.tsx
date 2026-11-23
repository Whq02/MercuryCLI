import type * as React from 'react'
import { useCallback } from 'react'
import { useMount } from '../hooks/effects.js'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Theme } from '../utils/theme.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'
import { notBuilt } from '../pi/holes.js'

type Priority = 'low' | 'medium' | 'high' | 'immediate'
type NoticeBase = {
  key: string
  priority: Priority
  invalidates?: string[]
  timeoutMs?: number
  fold?: (current: Notification, incoming: Notification) => Notification
}
type TextNotice = { text: string; wayOut?: string; detail?: string; color?: keyof Theme }
type NodeNotice = { jsx: React.ReactNode }
export type Notification = NoticeBase & (TextNotice | NodeNotice)

const PRIORITY_RANK: Record<Priority, number> = { immediate: 0, high: 1, medium: 2, low: 3 }

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

type SetAppState = (update: (state: AppState) => AppState) => void

let expiryTimer: NodeJS.Timeout | null = null

function cancelExpiry(): void {
  if (expiryTimer !== null) {
    stopTimeout(expiryTimer)
    expiryTimer = null
  }
}

function armExpiry(entry: Notification, setAppState: SetAppState): void {
  cancelExpiry()
  if (standsUntilRemoved(entry)) return
  expiryTimer = startTimeout(() => {
    expiryTimer = null
    setAppState(state => state.notifications.current?.key !== entry.key ? state : {
      ...state, notifications: { current: null, queue: state.notifications.queue },
    })
    promote(setAppState)
  }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

function promote(setAppState: SetAppState): void {
  setAppState(state => {
    if (state.notifications.current) return state
    const queue: Notification[] = state.notifications.queue
    const transient = queue.filter(entry => !standsUntilRemoved(entry))
    let next: Notification | undefined
    for (const entry of transient.length ? transient : queue) {
      if (!next || PRIORITY_RANK[entry.priority] < PRIORITY_RANK[next.priority]) next = entry
    }
    if (!next) return state
    armExpiry(next, setAppState)
    return { ...state, notifications: { current: next, queue: queue.filter(entry => entry !== next) } }
  })
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
