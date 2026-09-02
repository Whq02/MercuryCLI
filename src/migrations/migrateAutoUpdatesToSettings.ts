// ============================================================================
//  Startup migration A.1 — relocate the user's auto-update opt-out from
//  global config into user settings (env.DISABLE_AUTOUPDATER = "1").
//  Returns false (and keeps the config key) when the settings write did not
//  land — the runner then withholds the version stamp.
// ============================================================================
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

export function migrateAutoUpdatesToSettings(): boolean {
  try {
    const config = getGlobalConfig()
    // A config where auto-updates were disabled AUTOMATICALLY to protect a
    // native install is not a user preference — never migrate it.
    if (config.autoUpdates !== false) return true
    if (config.autoUpdatesProtectedForNative === true) return true

    const settings = getSettingsForSource('userSettings') ?? {}
    // Unconditional overwrite: the migration is definitively complete —
    // once the write has landed. A refused write keeps the opt-out where
    // it is.
    const verdict = updateSettingsForSource('userSettings', {
      env: { ...(settings.env ?? {}), DISABLE_AUTOUPDATER: '1' },
    })
    if (!settingsWriteLanded('A.1 auto-update opt-out', verdict)) return false
    // Take effect in the current session without a restart.
    process.env.DISABLE_AUTOUPDATER = '1'

    saveGlobalConfig(current => {
      const next = { ...current }
      delete next.autoUpdates
      delete next.autoUpdatesProtectedForNative
      return next
    })
    return true
  } catch (error) {
    logError(`auto-update settings migration failed: ${String(error)}`)
    return false
  }
}
