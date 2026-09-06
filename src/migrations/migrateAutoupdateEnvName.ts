import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

const RETIRED_KEY = 'DISABLE_AUTOUPDATER'

export function migrateAutoupdateEnvName(): boolean {
  try {
    const settings = getSettingsForSource('userSettings') ?? {}
    const env = settings.env ?? {}
    if (!(RETIRED_KEY in env)) return true
    const next = { ...env, [RETIRED_KEY]: undefined } as unknown as Record<string, string>
    const verdict = updateSettingsForSource('userSettings', { env: next })
    return settingsWriteLanded('A.10 retired auto-update key', verdict)
  } catch (error) {
    logError(`auto-update key migration failed: ${String(error)}`)
    return false
  }
}
