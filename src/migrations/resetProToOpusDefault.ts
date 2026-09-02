import { isProSubscriber } from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

export function resetProToOpusDefault(): void {
  if (getGlobalConfig().opusProMigrationComplete) return
  if (!isProSubscriber()) {
    saveGlobalConfig(current => ({ ...current, opusProMigrationComplete: true }))
    return
  }
  const settings = getSettings_DEPRECATED()
  if (settings?.model === undefined) {
    saveGlobalConfig(current => ({
      ...current,
      opusProMigrationComplete: true,
      opusProMigrationTimestamp: Date.now(),
    }))
  } else {
    saveGlobalConfig(current => ({ ...current, opusProMigrationComplete: true }))
  }
}
