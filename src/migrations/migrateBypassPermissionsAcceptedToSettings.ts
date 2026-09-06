import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import {
  hasSkipDangerousModePermissionPrompt,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

type RetiredAcceptanceKey = { bypassPermissionsModeAccepted?: boolean }

export function migrateBypassPermissionsAcceptedToSettings(): boolean {
  try {
    const config = getGlobalConfig() as ReturnType<typeof getGlobalConfig> & RetiredAcceptanceKey
    if (!config.bypassPermissionsModeAccepted) return true

    if (!hasSkipDangerousModePermissionPrompt()) {
      const verdict = updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true,
      })
      if (!settingsWriteLanded('A.2 sovereign-mode acceptance', verdict)) return false
    }

    saveGlobalConfig(current => {
      if (!('bypassPermissionsModeAccepted' in current)) return current
      const next = { ...current } as typeof current & RetiredAcceptanceKey
      delete next.bypassPermissionsModeAccepted
      return next
    })
    return true
  } catch (error) {
    logError(`sovereign-mode acceptance migration failed: ${String(error)}`)
    return false
  }
}
