// The priority notification queue: one displayed entry plus a
// pending list, backed by application state. Promotion picks the highest
// priority, earliest-queued entry; immediate pre-empts; fold merges by key;
// non-folding duplicates drop. The expiry timer is process-global — every
// consumer shares one handle — and its callback re-enters promotion so a
// chain of entries drains without further input.

import type * as React from 'react'
import { useCallback, useEffect } from 'react'
import { useAppStateStore, useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Theme } from '../utils/theme.js'

type Priority = 'low' | 'medium' | 'high' | 'immediate'

type BaseNotification = {
  key: string
  /** Keys this notification invalidates: they are removed from the queue
   *  and, when currently displayed, cleared immediately. */
  invalidates?: string[]
  priority: Priority
  timeoutMs?: number
  /** Merge same-key entries, Array.reduce-style: fold(accumulator,
   *  incoming) → merged. The result should carry fold forward. */
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

/** Highest priority wins; ties resolve to the earliest entry in queue
 *  order. Exported for the state store and for tests. */
export function getNext(queue: Notification[]): Notification | undefined {
  if (queue.length === 0) return undefined
  return queue.reduce((best, candidate) =>
    PRIORITY_RANK[candidate.priority] < PRIORITY_RANK[best.priority]
      ? candidate
      : best,
  )
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

// The ONE process-global expiry timer; any consumer cancelling it must null
// the shared handle.
let expiryTimer: NodeJS.Timeout | null = null

function cancelExpiry(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}

/** Arm the expiry for the given DISPLAYED entry. The callback clears only
 *  while the displayed entry is still THIS notification, compared by KEY —
 *  an equal-key re-created entry (a fold, a re-add) is the same
 *  notification and its timer is this one. Expiry never filters the
 *  pending list: invalidation belongs to the immediate path alone. */
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

/** Promote the next pending entry when nothing is displayed. */
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

/**
 * Module-level enqueue — the SAME channel as useNotifications()'s
 * addNotification, for callers outside the component tree that hold the app
 * setter (the bypass killswitch check, the wards registration, a tool's call
 * arm). Fold/dedupe by key, immediate pre-emption, and the promote step, so
 * an entry paints without waiting for the next hook action; a bare queue
 * push (the old direct-setAppState shape) sat invisible until something else
 * promoted.
 */
export function enqueueNotification(
  setAppState: SetAppState,
  incoming: Notification,
): void {
  if (incoming.priority === 'immediate') {
    // Pre-emption: cancel the running timer, display at once. The
    // previously displayed entry re-queues unless it was itself
    // immediate (discarded). Pending immediates and the incoming
    // entry's invalidated keys are dropped from the rebuilt list.
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
    // Non-folding duplicate keys drop entirely.
    if (
      current?.key === incoming.key ||
      queue.some(entry => entry.key === incoming.key)
    ) {
      return prev
    }
    // Invalidation on enqueue: a hit on the DISPLAYED key clears it
    // (timer cancelled); the pending list is filtered of the incoming
    // entry's invalidated keys AND of every pending immediate — on
    // every accepted non-folding enqueue.
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
  // A fold on the CURRENT entry restarts its timer; a fold on a queued
  // entry touches no timer.
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

  // Mount: promote once when the initial state already carries pending
  // entries. One-shot imperative read — a subscription here would re-render
  // every consumer on every queue change.
  useEffect(() => {
    if (store.getState().notifications.queue.length > 0) {
      promote(setAppState)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only; the store is a stable ref
  }, [])

  return { addNotification, removeNotification }
}
