import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { logError } from '../utils/log.js'

type RetiredAutoUpdateKeys = {
  autoUpdates?: boolean
  autoUpdatesProtectedForNative?: boolean
}

export function migrateAutoUpdatesToSettings(): boolean {
  try {
    const config = getGlobalConfig() as ReturnType<typeof getGlobalConfig> & RetiredAutoUpdateKeys
    if (config.autoUpdates === undefined && config.autoUpdatesProtectedForNative === undefined) return true
    saveGlobalConfig(current => {
      const next = { ...current } as typeof current & RetiredAutoUpdateKeys
      delete next.autoUpdates
      delete next.autoUpdatesProtectedForNative
      return next
    })
    return true
  } catch (error) {
    logError(`auto-update key retirement failed: ${String(error)}`)
    return false
  }
}
