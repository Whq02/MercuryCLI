import { flagEnv } from '../substrate/flagRegistry.js'
import { clearCACertsCache } from './caCerts.js'
import { isEnvTruthy } from './envUtils.js'
import { isProviderManagedEnvVar, SAFE_ENV_VARS } from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled, type SettingSource } from './settings/constants.js'
import { getInitialSettings, getSettingsForSource } from './settings/settings.js'
import { subprocessEnv } from './subprocessEnv.js'
import { hostEnv } from './hostEnv.js'

type EnvObject = Record<string, string>


const TUNNEL_PROTECTED_KEYS = [
  'MERCURY_API_UNIX_SOCKET',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
] as const

function filterTunnelProtected(env: EnvObject): EnvObject {
  if (flagEnv('MERCURY_API_UNIX_SOCKET') === undefined) return env
  const out: EnvObject = { ...env }
  for (const key of TUNNEL_PROTECTED_KEYS) delete out[key]
  return out
}

function filterProviderManaged(env: EnvObject): EnvObject {
  if (!isEnvTruthy(flagEnv('MERCURY_PROVIDER_MANAGED_BY_HOST'))) return env
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isProviderManagedEnvVar(key)))
}

function applyFiltered(env: EnvObject | undefined): void {
  if (!env) return
  const filtered = filterProviderManaged(filterTunnelProtected(env))
  for (const [key, value] of Object.entries(filtered)) {
    hostEnv()[key] = value
  }
}


const TRUSTED_SOURCES_BEFORE_POLICY: readonly SettingSource[] = ['userSettings', 'flagSettings']

export function applySafeConfigEnvironmentVariables(): void {
  for (const source of TRUSTED_SOURCES_BEFORE_POLICY) {
    if (isSettingSourceEnabled(source)) applyFiltered(getSettingsForSource(source)?.environment?.values)
  }
  applyFiltered(getSettingsForSource('policySettings')?.environment?.values)
  const values: EnvObject = getInitialSettings().environment?.values ?? {}
  applyFiltered(Object.fromEntries(Object.entries(values).filter(([key]) => SAFE_ENV_VARS.has(key.toUpperCase()))))
}


export function applyConfigEnvironmentVariables(): void {
  applyFiltered(getInitialSettings().environment?.values)
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()
  configureGlobalAgents()
}

export function configEnvironmentIsApplied(): boolean {
  const env = subprocessEnv()
  return Object.entries(getInitialSettings().environment?.values ?? {}).every(([key, value]) => env[key] === String(value))
}
