// ============================================================================
//  Startup migration A.2 — relocate the recorded dangerous-mode acceptance
//  from global config into the user-settings skip flag.
//  Returns false (and keeps the config key) when the settings write did not
//  land — the runner then withholds the version stamp.
// ============================================================================
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

    // The shared predicate: true when the skip key is set in the user,
    // local, flag or policy source — project settings are DELIBERATELY
    // excluded (a repository must not pre-accept the dangerous-mode
    // prompt), so a project-level true does not suppress the write here.
    if (!hasSkipDangerousModePermissionPrompt()) {
      // A refused write keeps the acceptance in the config — deleting it
      // here brought the dangerous-mode dialog back for good.
      const verdict = updateSettingsForSource('userSettings', {
        skipDangerousModePermissionPrompt: true,
      })
      if (!settingsWriteLanded('A.2 dangerous-mode acceptance', verdict)) return false
    }

    saveGlobalConfig(current => {
      // Absent key ⇒ previous state unchanged (no pointless write).
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
