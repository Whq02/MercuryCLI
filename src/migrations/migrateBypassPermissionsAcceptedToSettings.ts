import { getGlobalConfig, saveGlobalConfigDeferred } from '../utils/config.js'
import {
  hasSkipSovereignConsentPrompt,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

type RetiredAcceptanceKey = { bypassPermissionsModeAccepted?: boolean }

export function migrateBypassPermissionsAcceptedToSettings(): boolean {
  try {
    const config = getGlobalConfig() as ReturnType<typeof getGlobalConfig> & RetiredAcceptanceKey
    if (!config.bypassPermissionsModeAccepted) return true

    if (!hasSkipSovereignConsentPrompt()) {
      const verdict = updateSettingsForSource('userSettings', {
        skipSovereignConsentPrompt: true,
      })
      if (!settingsWriteLanded('A.2 sovereign-mode acceptance', verdict)) return false
    }

    saveGlobalConfigDeferred(current => {
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
