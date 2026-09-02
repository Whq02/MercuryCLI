// Live count of settings validation errors → a notice pointing at the health
// surface. The one hook in the family that RETURNS data: the remote gate
// wraps only the emit/remove effect, because the caller renders the list even
// in remote mode.

import { useEffect, useState } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { useNotifications } from '../../context/notifications.js'
import { getSettingsWithAllErrors } from '../../utils/settings/allErrors.js'
import type { ValidationError } from '../../utils/settings/validation.js'
import { useSettingsChange } from '../useSettingsChange.js'

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

  useEffect(() => {
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
