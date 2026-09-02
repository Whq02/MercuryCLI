// The shared once-per-session notification primitive: remote-mode gate +
// run-once guard + sync-or-async compute. Exists so the family of startup
// notices stops hand-rolling the same three pieces.

import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications, type Notification } from '../../context/notifications.js'
import { logError } from '../../utils/log.js'

export type StartupNotificationCompute = () =>
  | Notification
  | Notification[]
  | null
  | Promise<Notification | Notification[] | null>

export function useStartupNotification(compute: StartupNotificationCompute): void {
  const { addNotification } = useNotifications()
  const ranRef = useRef(false)
  const computeRef = useRef(compute)
  computeRef.current = compute

  // No dependency list on purpose: the remote-mode check runs BEFORE the
  // run-once ref is latched, so a session that leaves remote mode can still
  // run the compute on a later effect pass.
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (ranRef.current) return
    ranRef.current = true
    // Invoked from a resolved-promise continuation so even a synchronous
    // compute publishes a microtask after the effect, never during it.
    void Promise.resolve()
      .then(() => computeRef.current())
      .then(result => {
        if (!result) return
        const notifications = Array.isArray(result) ? result : [result]
        for (const notification of notifications) {
          addNotification(notification)
        }
      })
      .catch(error => logError(error))
  })
}
