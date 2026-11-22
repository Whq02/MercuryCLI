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

function armExpiry(entry: Notification, setAppState: SetAppState): void {
  return notBuilt('src/context/notifications.tsx:75')
}

function promote(setAppState: SetAppState): void {
  return notBuilt('src/context/notifications.tsx:91')
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
