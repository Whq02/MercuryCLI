
import { useState } from 'react'
import { usePublish } from '../effects/effects.js'
import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { useNotifications } from './notifications.js'
import { getSettingsWithAllErrors } from '../../platform/settings-faults/allErrors.js'
import type { ValidationError } from '../../platform/settings/validation.js'
import { useSettingsChange } from '../settings/useSettingsChange.js'

const NOTIFICATION_KEY = 'settings-errors'
const NOTIFICATION_TIMEOUT_MS = 60_000

export function useSettingsErrors(): ValidationError[] {
  const { addNotification, removeNotification } = useNotifications()
  const [errors, setErrors] = useState<ValidationError[]>(
    () => getSettingsWithAllErrors().errors,
  )

  useSettingsChange(() => {
    setErrors(getSettingsWithAllErrors().errors)
  })

  usePublish(() => {
    if (getIsRemoteMode()) return
    if (errors.length > 0) {
      addNotification({
        key: NOTIFICATION_KEY,
        text: `${errors.length} settings ${errors.length === 1 ? 'issue' : 'issues'} — /health for details`,
        color: 'warning',
        priority: 'high',
        timeoutMs: NOTIFICATION_TIMEOUT_MS,
      })
    } else {
      removeNotification(NOTIFICATION_KEY)
    }
  }, [errors, addNotification, removeNotification])

  return errors
}
