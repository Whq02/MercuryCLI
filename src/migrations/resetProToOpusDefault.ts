// ============================================================================
//  Startup migration A.9 — one-shot notice decision for the Pro default-
//  model change. Writes NO model value; every branch ends complete.
// ============================================================================
import { isProSubscriber } from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getSettings_DEPRECATED } from '../utils/settings/settings.js'

export function resetProToOpusDefault(): void {
  if (getGlobalConfig().opusProMigrationComplete) return
  if (!isProSubscriber()) {
    // Permanently done for them.
    saveGlobalConfig(current => ({ ...current, opusProMigrationComplete: true }))
    return
  }
  // The deliberate exception to the narrow-source law: merged settings are
  // safe here because nothing is written back.
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
