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
  if (incoming.priority === 'immediate') {
    cancelExpiry()
    setAppState(prev => {
      const displaced = prev.notifications.current
      const requeued =
        displaced !== null && displaced.priority !== 'immediate'
          ? [displaced]
          : []
      const queue = [...requeued, ...prev.notifications.queue].filter(
        entry =>
          entry.priority !== 'immediate' &&
          !incoming.invalidates?.includes(entry.key),
      )
      return {
        ...prev,
        notifications: { current: incoming, queue },
      }
    })
    armExpiry(incoming, setAppState)
    return
  }

  let foldedIntoCurrent: Notification | null = null
  setAppState(prev => {
    const { current, queue } = prev.notifications
    if (incoming.fold) {
      if (current?.key === incoming.key) {
        const folded = incoming.fold(current as Notification, incoming)
        foldedIntoCurrent = folded
        return {
          ...prev,
          notifications: { current: folded, queue },
        }
      }
      const at = queue.findIndex(entry => entry.key === incoming.key)
      if (at !== -1) {
        const folded = incoming.fold(queue[at] as Notification, incoming)
        const nextQueue = [...queue]
        nextQueue[at] = folded
        return {
          ...prev,
          notifications: { current, queue: nextQueue },
        }
      }
    }
    if (
      current?.key === incoming.key ||
      queue.some(entry => entry.key === incoming.key)
    ) {
      return prev
    }
    const invalidatesCurrent =
      current !== null && incoming.invalidates?.includes(current.key) === true
    if (invalidatesCurrent) cancelExpiry()
    const yields =
      current !== null && !invalidatesCurrent && standsUntilRemoved(current) && !standsUntilRemoved(incoming)
    const filtered = queue.filter(
      entry =>
        entry.priority !== 'immediate' &&
        !incoming.invalidates?.includes(entry.key),
    )
    return {
      ...prev,
      notifications: {
        current: invalidatesCurrent || yields ? null : current,
        queue: [...filtered, incoming, ...(yields ? [current as Notification] : [])],
      },
    }
  })
  if (foldedIntoCurrent !== null) {
    armExpiry(foldedIntoCurrent, setAppState)
    return
  }
  promote(setAppState)
}

export function useNotifications(): {
  addNotification: (notification: Notification) => void
  removeNotification: (key: string) => void
} {
  return notBuilt('src/context/notifications.tsx:187')
}
