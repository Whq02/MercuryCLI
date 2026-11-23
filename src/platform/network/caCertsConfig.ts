import { logForDebugging } from '../logs/debugLog.js'
import { logError } from '../logs/errorLog.js'
import { getSettingsForSource } from '../settings/settings.js'
import { hostEnv } from '../environment/hostEnv.js'

export function applyExtraCACertsFromConfig(): void {
  if (hostEnv().NODE_EXTRA_CA_CERTS) return

  let configPath: string | undefined
  try {
    const userEnv = getSettingsForSource('userSettings')?.environment?.values
    const settingsPath = userEnv?.NODE_EXTRA_CA_CERTS
    if (settingsPath) configPath = settingsPath
  } catch (err) {
    logError(err)
  }

  if (configPath) {
    hostEnv().NODE_EXTRA_CA_CERTS = configPath
    logForDebugging(`caCertsConfig: NODE_EXTRA_CA_CERTS set from config/settings: ${configPath}`)
  }
}
