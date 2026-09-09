import { saveGlobalConfigDeferred } from '../utils/config.js'

const LEGACY_KEY = 'replBridgeEnabled'

export function migrateReplBridgeEnabledToRemoteControlAtStartup(): void {
  saveGlobalConfigDeferred(current => {
    const record = current as Record<string, unknown>
    if (!(LEGACY_KEY in record)) return current
    if (current.remoteControlAtStartup !== undefined) return current
    const next = { ...current, remoteControlAtStartup: Boolean(record[LEGACY_KEY]) }
    delete (next as Record<string, unknown>)[LEGACY_KEY]
    return next
  })
}
