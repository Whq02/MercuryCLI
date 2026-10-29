import { userInfo } from 'node:os'


export const MACOS_PREFERENCE_DOMAIN = 'com.mercury.harness'

export const WINDOWS_REGISTRY_KEY_PATH_HKLM = 'HKLM\\SOFTWARE\\Policies\\Mercury'
export const WINDOWS_REGISTRY_KEY_PATH_HKCU = 'HKCU\\SOFTWARE\\Policies\\Mercury'
export const WINDOWS_REGISTRY_VALUE_NAME = 'Settings'

export const PLUTIL_PATH = '/usr/bin/plutil'
export const PLUTIL_ARGS_PREFIX = ['-convert', 'json', '-o', '-', '--']
export const MDM_SUBPROCESS_TIMEOUT_MS = 5000

const MANAGED_PREFERENCES_ROOT = '/Library/Managed Preferences'

export function getMacOSPlistPaths(): Array<{ path: string; label: string }> {
  let username: string | null = null
  try {
    username = userInfo().username || null
  } catch {
    username = null
  }
  const paths: Array<{ path: string; label: string }> = []
  if (username !== null) {
    paths.push({
      path: `${MANAGED_PREFERENCES_ROOT}/${username}/${MACOS_PREFERENCE_DOMAIN}.plist`,
      label: `managed preferences (user, ${MACOS_PREFERENCE_DOMAIN})`,
    })
  }
  paths.push({
    path: `${MANAGED_PREFERENCES_ROOT}/${MACOS_PREFERENCE_DOMAIN}.plist`,
    label: `managed preferences (device, ${MACOS_PREFERENCE_DOMAIN})`,
  })
  return paths
}
