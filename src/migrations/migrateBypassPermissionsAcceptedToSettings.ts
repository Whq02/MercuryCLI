import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  hasSkipDangerousModePermissionPrompt,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

export function migrateBypassPermissionsAcceptedToSettings(): boolean {
  try {
    const config = getGlobalConfig()
    if (!config.bypassPermissionsModeAccepted) return true

    if (!hasSkipDangerousModePermissionPrompt()) {
      const verdict = updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true,
      })
      if (!settingsWriteLanded('A.2 dangerous-mode acceptance', verdict)) return false
    }

    saveGlobalConfig(current => {
      if (!('bypassPermissionsModeAccepted' in current)) return current
      const next = { ...current }
      delete next.bypassPermissionsModeAccepted
      return next
    })
    return true
  } catch (error) {
    logError(`bypass-permissions settings migration failed: ${String(error)}`)
    return false
  }
}
