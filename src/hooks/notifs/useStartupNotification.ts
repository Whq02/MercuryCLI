
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

  useEffect(() => {
    if (getIsRemoteMode()) return
    if (ranRef.current) return
    ranRef.current = true
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
