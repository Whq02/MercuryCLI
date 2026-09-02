//  global config into user settings (env.DISABLE_AUTOUPDATER = "1").
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

export function migrateAutoUpdatesToSettings(): boolean {
  try {
    const config = getGlobalConfig()
    if (config.autoUpdates !== false) return true
    if (config.autoUpdatesProtectedForNative === true) return true

    const settings = getSettingsForSource('userSettings') ?? {}
    const verdict = updateSettingsForSource('userSettings', {
      env: { ...(settings.env ?? {}), DISABLE_AUTOUPDATER: '1' },
    })
    if (!settingsWriteLanded('A.1 auto-update opt-out', verdict)) return false
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
