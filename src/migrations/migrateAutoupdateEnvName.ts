import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { logError } from '../utils/log.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

const RETIRED_KEY = 'DISABLE_AUTOUPDATER'

export function migrateAutoupdateEnvName(): boolean {
  try {
    const settings = getSettingsForSource('userSettings') ?? {}
    const env = settings.env ?? {}
    if (!(RETIRED_KEY in env)) return true
    const on = /^(1|true|yes|on)$/i.test(String(env[RETIRED_KEY] ?? '').trim())
    const next = { ...env, [RETIRED_KEY]: undefined, ...(on ? { MERCURY_AUTOUPDATE: '0' } : {}) } as unknown as Record<string, string>
    const verdict = updateSettingsForSource('userSettings', { env: next })
    return settingsWriteLanded('A.10 auto-update switch name', verdict)
  } catch (error) {
    logError(`auto-update switch migration failed: ${String(error)}`)
    return false
  }
}
