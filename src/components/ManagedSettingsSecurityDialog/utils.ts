// The dangerous-settings model behind the managed-settings approval gate —
// pure and reusable (the remote-managed-settings service drives it too).
// The extraction retains VALUES so the change comparison can catch a changed
// command line; the UI list is derived separately and carries NAMES ONLY.

import isEqual from 'lodash-es/isEqual.js'
import {
  DANGEROUS_SHELL_SETTINGS,
  SAFE_ENV_VARS,
} from '../../utils/managedEnvConstants.js'
import type { SettingsJson } from '../../utils/settings/types.js'

export type DangerousSettings = {
  /** Shell-executing settings, key → configured command line. */
  shellSettings: Record<string, string>
  /** Non-allowlisted environment variables, name → value. */
  envVars: Record<string, string>
  /** The hooks object when present and non-empty, else null. */
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

  // Deny by default: the shared allow-list is the only authority, checked on
  // the UPPER-CASED name.
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

/**
 * Does the incoming document require re-approval? False when the new
 * settings are not dangerous at all; true when danger appears where there
 * was none; otherwise a structural comparison — ANY difference, including a
 * changed value, requires re-approval.
 */
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

/**
 * The approval dialog's list — setting NAMES only, never values (the dialog
 * must not print an API-key helper command line or a token-bearing env
 * value): shell-setting keys, then env-var names, then the literal token
 * `hooks` when hooks are present.
 */
export function dangerousSettingNames(dangerous: DangerousSettings): string[] {
  return [
    ...Object.keys(dangerous.shellSettings),
    ...Object.keys(dangerous.envVars),
    ...(dangerous.hooks !== null ? ['hooks'] : []),
  ]
}
