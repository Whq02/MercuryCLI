import { clearCACertsCache } from './caCerts.js'
import { isEnvTruthy } from './envUtils.js'
import { isProviderManagedEnvVar, SAFE_ENV_VARS } from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled, type SettingSource } from './settings/constants.js'
import { getSettings_DEPRECATED, getSettingsForSource } from './settings/settings.js'


type EnvObject = Record<string, string>


const TUNNEL_PROTECTED_KEYS = [
  'MERCURY_API_UNIX_SOCKET',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
] as const

function filterTunnelProtected(env: EnvObject): EnvObject {
  if (process.env.MERCURY_API_UNIX_SOCKET === undefined) return env
  const out: EnvObject = { ...env }
  for (const key of TUNNEL_PROTECTED_KEYS) delete out[key]
  return out
}

function filterProviderManaged(env: EnvObject): EnvObject {
  if (!isEnvTruthy(process.env.MERCURY_PROVIDER_MANAGED_BY_HOST)) return env
  const out: EnvObject = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isProviderManagedEnvVar(key)) out[key] = value
  }
  return out
}

function applyFiltered(env: EnvObject | undefined): void {
  if (!env) return
  const filtered = filterProviderManaged(filterTunnelProtected(env))
  for (const [key, value] of Object.entries(filtered)) {
    process.env[key] = value
  }
}


const TRUSTED_SOURCES_BEFORE_POLICY: readonly SettingSource[] = ['userSettings', 'flagSettings']

export function applySafeConfigEnvironmentVariables(): void {
  for (const source of TRUSTED_SOURCES_BEFORE_POLICY) {
    if (!isSettingSourceEnabled(source)) continue
    applyFiltered(getSettingsForSource(source)?.environment?.values)
  }
  applyFiltered(getSettingsForSource('policySettings')?.environment?.values)
  const merged = getSettings_DEPRECATED().environment?.values
  if (merged) {
    const allowlisted: EnvObject = {}
    for (const [key, value] of Object.entries(merged)) {
      if (SAFE_ENV_VARS.has(key.toUpperCase())) allowlisted[key] = value
    }
    applyFiltered(allowlisted)
  }
}


export function applyConfigEnvironmentVariables(): void {
  applyFiltered(getSettings_DEPRECATED().environment?.values)
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()
  configureGlobalAgents()
}
