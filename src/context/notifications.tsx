
import type * as React from 'react'
import { useCallback, useEffect } from 'react'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Theme } from '../utils/theme.js'

type Priority = 'low' | 'medium' | 'high' | 'immediate'

type BaseNotification = {
  key: string
  invalidates?: string[]
  priority: Priority
  timeoutMs?: number
  fold?: (accumulator: Notification, incoming: Notification) => Notification
}

type TextNotification = BaseNotification & {
  text: string
  color?: keyof Theme
}

type JSXNotification = BaseNotification & {
  jsx: React.ReactNode
}

export type Notification = TextNotification | JSXNotification

const DEFAULT_TIMEOUT_MS = 8000

const PRIORITY_RANK: Record<Priority, number> = {
  immediate: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function getNext(queue: Notification[]): Notification | undefined {
  if (queue.length === 0) return undefined
  return queue.reduce((best, candidate) =>
    PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[best.priority]
      ? candidate
      : best,
  )
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

let expiryTimer: NodeJS.Timeout | null = null

function cancelExpiry(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}

function armExpiry(entry: Notification, setAppState: SetAppState): void {
  cancelExpiry()
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    setAppState(prev => {
      if (prev.notifications.current?.key !== entry.key) return prev
      return {
        ...prev,
        notifications: { current: null, queue: prev.notifications.queue },
      }
    })
    promote(setAppState)
  }, entry.timeoutMs ?? DEFAULT_TIMEOUT_MS)
}

function promote(setAppState: SetAppState): void {
  setAppState(prev => {
    if (prev.notifications.current !== null) return prev
    const next = getNext(prev.notifications.queue as Notification[])
    if (next === undefined) return prev
    armExpiry(next, setAppState)
    return {
      ...prev,
      notifications: {
        current: next,
        queue: prev.notifications.queue.filter(entry => entry !== next),
      },
    }
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
    const filtered = queue.filter(
      entry =>
        entry.priority !== 'immediate' &&
        !incoming.invalidates?.includes(entry.key),
    )
    return {
      ...prev,
      notifications: {
        current: invalidatesCurrent ? null : current,
        queue: [...filtered, incoming],
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
  const store = useAppStateStore()
  const setAppState = useSetAppState()

  const addNotification = useCallback(
    (incoming: Notification): void => enqueueNotification(setAppState, incoming),
    [setAppState],
  )

  const removeNotification = useCallback(
    (key: string): void => {
      setAppState(prev => {
        const { current, queue } = prev.notifications
        const isCurrent = current?.key === key
        const inQueue = queue.some(entry => entry.key === key)
        if (!isCurrent && !inQueue) return prev
        if (isCurrent) cancelExpiry()
        return {
          ...prev,
          notifications: {
            current: isCurrent ? null : current,
            queue: queue.filter(entry => entry.key !== key),
          },
        }
      })
      promote(setAppState)
    },
    [setAppState],
  )

  useEffect(() => {
    if (store.getState().notifications.queue.length > 0) {
      promote(setAppState)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; the store is a stable ref
  }, [])

  return { addNotification, removeNotification }
}
