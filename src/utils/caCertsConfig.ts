import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { logError } from './log.js'
import { getSettingsForSource } from './settings/settings.js'

/**
 * The one sanctioned config bridge for extra CA certificates. Called only
 * from init, early, before any TLS connection — Bun caches the certificate
 * store at process boot, so the env var must be populated before the first
 * connection.
 *
 * Project-level settings are deliberately NOT read here: they must not be
 * able to inject a CA before the trust dialog has run.
 */
export function applyExtraCACertsFromConfig(): void {
  if (process.env.NODE_EXTRA_CA_CERTS) return

  let configPath: string | undefined
  try {
    configPath = getGlobalConfig().env?.NODE_EXTRA_CA_CERTS
  } catch (err) {
    logError(err)
  }
  try {
    // User-level settings win over the global config value.
    const userEnv = getSettingsForSource('userSettings')?.env
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
