// Surfaces the current model's deprecation warning, deduped by warning text.
// Clearing the last-shown record when the warning goes away is deliberate: a
// later re-entry into a deprecated model warns again.

import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { getModelDeprecationWarning } from '../../utils/model/deprecation.js'

const NOTIFICATION_KEY = 'model-deprecation-warning'

export function useDeprecationWarningNotification(model: string): void {
  const { addNotification } = useNotifications()
  const lastWarningRef = useRef<string | null>(null)

  useEffect(() => {
    if (getIsRemoteMode()) return
    const warning = getModelDeprecationWarning(model)
    if (warning) {
      if (warning === lastWarningRef.current) return
      lastWarningRef.current = warning
      addNotification({
        key: NOTIFICATION_KEY,
        text: warning,
        color: 'warning',
        priority: 'high',
      })
    } else {
      lastWarningRef.current = null
    }
  }, [model, addNotification])
}
