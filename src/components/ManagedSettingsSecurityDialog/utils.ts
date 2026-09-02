
import isEqual from 'lodash-es/isEqual.js'
import {
  DANGEROUS_SHELL_SETTINGS,
  SAFE_ENV_VARS,
} from '../../utils/managedEnvConstants.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export type DangerousSettings = {
  shellSettings: Record<string, string>
  envVars: Record<string, string>
  hooks: Record<string, unknown> | null
}

export function extractDangerousSettings(
  settings: SettingsJson,
): DangerousSettings {
  const record = settings as Record<string, unknown>

  const shellSettings: Record<string, string> = {}
  for (const key of DANGEROUS_SHELL_SETTINGS) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') {
      shellSettings[key] = value
    }
  }

  const envVars: Record<string, string> = {}
  const env = record['env']
  if (env !== null && typeof env === 'object') {
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== 'string' || value === '') continue
      if (SAFE_ENV_VARS.has(name.toUpperCase())) continue
      envVars[name] = value
    }
  }

  const hooks = record['hooks']
  const dangerousHooks =
    hooks !== null &&
    hooks !== undefined &&
    typeof hooks === 'object' &&
    Object.keys(hooks).length > 0
      ? (hooks as Record<string, unknown>)
      : null

  return { shellSettings, envVars, hooks: dangerousHooks }
}

export function hasDangerousSettings(dangerous: DangerousSettings): boolean {
  return (
    Object.keys(dangerous.shellSettings).length > 0 ||
    Object.keys(dangerous.envVars).length > 0 ||
    dangerous.hooks !== null
  )
}

export function hasDangerousSettingsChanged(
  oldSettings: SettingsJson | null,
  newSettings: SettingsJson,
): boolean {
  const next = extractDangerousSettings(newSettings)
  if (!hasDangerousSettings(next)) return false
  const previous = oldSettings ? extractDangerousSettings(oldSettings) : null
  if (previous === null || !hasDangerousSettings(previous)) return true
  return !isEqual(previous, next)
}

export function dangerousSettingNames(dangerous: DangerousSettings): string[] {
  return [
    ...Object.keys(dangerous.shellSettings),
    ...Object.keys(dangerous.envVars),
    ...(dangerous.hooks !== null ? ['hooks'] : []),
  ]
}
