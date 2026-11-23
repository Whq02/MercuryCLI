import { useRef } from 'react'
import { usePublish } from '../effects/effects.js'
import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { useNotifications } from './notifications.js'
import { getModelDeprecationWarning } from '../../models/facts/deprecation.js'

const NOTIFICATION_KEY = 'model-deprecation-warning'

export function useDeprecationWarningNotification(model: string): void {
  const { addNotification } = useNotifications()
  const lastWarningRef = useRef<string | null>(null)

  usePublish(() => {
    if (getIsRemoteMode()) return
    const warning = getModelDeprecationWarning(model)
    if (!warning) {
      lastWarningRef.current = null
      return
    }
    if (warning === lastWarningRef.current) return
    lastWarningRef.current = warning
    addNotification({
      key: NOTIFICATION_KEY,
      text: warning,
      color: 'warning',
      priority: 'high',
    })
  }, [model, addNotification])
}
