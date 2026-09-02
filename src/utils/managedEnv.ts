import { isRemoteManagedSettingsEligible } from '../services/remoteManagedSettings/syncCache.js'
import { clearCACertsCache } from './caCerts.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'
import { isProviderManagedEnvVar, SAFE_ENV_VARS } from './managedEnvConstants.js'
import { clearMTLSCache } from './mtls.js'
import { clearProxyCache, configureGlobalAgents } from './proxy.js'
import { isSettingSourceEnabled, type SettingSource } from './settings/constants.js'
import { getSettings_DEPRECATED, getSettingsForSource } from './settings/settings.js'

/**
 * Apply settings-sourced environment variables to the process, in an order
 * that never lets a project-scoped file redirect inference traffic and never
 * lets a host that owns routing be overridden.
 */

type EnvObject = Record<string, string>

// ---------------------------------------------------------------------------
// The two filter families — independent, and both compose
// ---------------------------------------------------------------------------

/** Placeholder auth the SSH-tunnel launcher plants; the far side's settings must not clobber them. */
const TUNNEL_PROTECTED_KEYS = [
  'ANTHROPIC_UNIX_SOCKET',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'MERCURY_OAUTH_TOKEN',
] as const

function filterTunnelProtected(env: EnvObject): EnvObject {
  if (process.env.ANTHROPIC_UNIX_SOCKET === undefined) return env
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

// ---------------------------------------------------------------------------
// Pre-trust
// ---------------------------------------------------------------------------

/** The user-controlled, non-project sources; policy is applied last so it wins. */
const TRUSTED_SOURCES_BEFORE_POLICY: readonly SettingSource[] = ['userSettings', 'flagSettings']

/**
 * Called BEFORE the trust dialog so user/enterprise configuration such as an
 * alternate endpoint takes effect during first run. Order is the contract:
 * global config env; user then flag sources (each only
 * when enabled — an SDK embedder may restrict sources to keep personal
 * configuration out of an automated run); remote managed-settings
 * eligibility computed HERE (it reads variables the previous steps may have
 * set, and the policy read that follows consults the cache it primes);
 * policy; and finally the allowlisted keys of the fully merged settings.
 */
export function applySafeConfigEnvironmentVariables(): void {
  applyFiltered(getGlobalConfig().env as EnvObject | undefined)
  for (const source of TRUSTED_SOURCES_BEFORE_POLICY) {
    if (!isSettingSourceEnabled(source)) continue
    applyFiltered(getSettingsForSource(source)?.env)
  }
  isRemoteManagedSettingsEligible()
  applyFiltered(getSettingsForSource('policySettings')?.env)
  const merged = getSettings_DEPRECATED().env
  if (merged) {
    const allowlisted: EnvObject = {}
    for (const [key, value] of Object.entries(merged)) {
      if (SAFE_ENV_VARS.has(key.toUpperCase())) allowlisted[key] = value
    }
    applyFiltered(allowlisted)
  }
}

// ---------------------------------------------------------------------------
// Post-trust
// ---------------------------------------------------------------------------

/** After trust: every variable, still filtered; then rebuild the network agents against the new values. */
export function applyConfigEnvironmentVariables(): void {
  applyFiltered(getGlobalConfig().env as EnvObject | undefined)
  applyFiltered(getSettings_DEPRECATED().env)
  clearCACertsCache()
  clearMTLSCache()
  clearProxyCache()
  configureGlobalAgents()
}
