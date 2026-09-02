import { userInfo } from 'node:os'

/**
 * MDM identifiers and path builders. The Mercury preference domain and
 * registry keys are primary; the imported spellings remain as
 * compatibility inputs.
 */

export const MACOS_PREFERENCE_DOMAIN = 'com.mercury.harness'
export const LEGACY_MACOS_PREFERENCE_DOMAIN = 'com.anthropic.claudecode'

export const WINDOWS_REGISTRY_KEY_PATH_HKLM = 'HKLM\\SOFTWARE\\Policies\\Mercury'
export const LEGACY_WINDOWS_REGISTRY_KEY_PATH_HKLM = 'HKLM\\SOFTWARE\\Policies\\ClaudeCode'
export const WINDOWS_REGISTRY_KEY_PATH_HKCU = 'HKCU\\SOFTWARE\\Policies\\Mercury'
export const LEGACY_WINDOWS_REGISTRY_KEY_PATH_HKCU = 'HKCU\\SOFTWARE\\Policies\\ClaudeCode'
export const WINDOWS_REGISTRY_VALUE_NAME = 'Settings'

export const PLUTIL_PATH = '/usr/bin/plutil'
export const PLUTIL_ARGS_PREFIX = ['-convert', 'json', '-o', '-', '--']
export const MDM_SUBPROCESS_TIMEOUT_MS = 5000

const MANAGED_PREFERENCES_ROOT = '/Library/Managed Preferences'

/**
 * Candidate plists in priority order: the per-user tier beats the device
 * tier; inside each tier the Mercury domain beats the compatibility
 * domain. Only the admin-controlled managed-preferences location is
 * consulted — never the user-writable preferences. Per-user entries are
 * omitted when the username cannot be determined.
 */
export function getMacOSPlistPaths(): Array<{ path: string; label: string }> {
  let username: string | null = null
  try {
    username = userInfo().username || null
  } catch {
    username = null
  }
  const paths: Array<{ path: string; label: string }> = []
  if (username !== null) {
    paths.push(
      {
        path: `${MANAGED_PREFERENCES_ROOT}/${username}/${MACOS_PREFERENCE_DOMAIN}.plist`,
        label: `managed preferences (user, ${MACOS_PREFERENCE_DOMAIN})`,
      },
      {
        path: `${MANAGED_PREFERENCES_ROOT}/${username}/${LEGACY_MACOS_PREFERENCE_DOMAIN}.plist`,
        label: `managed preferences (user, ${LEGACY_MACOS_PREFERENCE_DOMAIN})`,
      },
    )
  }
  paths.push(
    {
      path: `${MANAGED_PREFERENCES_ROOT}/${MACOS_PREFERENCE_DOMAIN}.plist`,
      label: `managed preferences (device, ${MACOS_PREFERENCE_DOMAIN})`,
    },
    {
      path: `${MANAGED_PREFERENCES_ROOT}/${LEGACY_MACOS_PREFERENCE_DOMAIN}.plist`,
      label: `managed preferences (device, ${LEGACY_MACOS_PREFERENCE_DOMAIN})`,
    },
  )
  return paths
}
