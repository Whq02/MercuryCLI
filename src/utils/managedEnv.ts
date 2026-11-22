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
import { notBuilt } from '../pi/holes.js'


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
  return notBuilt('src/utils/managedEnv.ts:31')
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
  return notBuilt('src/utils/managedEnv.ts:51')
}


export function applyConfigEnvironmentVariables(): void {
  return notBuilt('src/utils/managedEnv.ts:68')
}

export function configEnvironmentIsApplied(): boolean {
  const env = subprocessEnv()
  return Object.entries(getInitialSettings().environment?.values ?? {}).every(([key, value]) => env[key] === String(value))
}
