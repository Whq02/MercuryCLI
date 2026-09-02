// ============================================================================
//  Startup migration A.8 — rename the legacy bridge key to
//  remoteControlAtStartup (boolean-coerced), one identity-guarded update.
// ============================================================================
import { saveGlobalConfig } from '../utils/config.js'

const LEGACY_KEY = 'replBridgeEnabled'

export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void {
  saveGlobalConfig(current => {
    const record = current as Record<string, unknown>
    // Returning the PREVIOUS object in the no-op cases lets the store's
    // identity check suppress a needless write.
    if (!(LEGACY_KEY in record)) return current
    if (current.remoteControlAtStartup !== undefined) return current
    const next = { ...current, remoteControlAtStartup: Boolean(record[LEGACY_KEY]) }
    delete (next as Record<string, unknown>)[LEGACY_KEY]
    return next
  })
}
