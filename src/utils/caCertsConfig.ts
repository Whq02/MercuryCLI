import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import { getSettingsForSource } from './settings/settings.js'

export function applyExtraCACertsFromConfig(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) return

  let configPath: string | undefined
  try {
    const userEnv = getSettingsForSource('userSettings')?.environment?.values
    const settingsPath = userEnv?.NODE_EXTRA_CA_CERTS
    if (settingsPath) configPath = settingsPath
  } catch (err) {
    logError(err)
  }

  if (configPath) {
    process.env.NODE_EXTRA_CA_CERTS = configPath
    logForDebugging(`caCertsConfig: NODE_EXTRA_CA_CERTS set from config/settings: ${configPath}`)
  }
}
