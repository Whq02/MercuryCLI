import { userInfo } from 'node:os'

import { passedOver } from '../../passedOver.js'

export const MACOS_PREFERENCE_DOMAIN = 'com.mercury.harness'

export const WINDOWS_REGISTRY_KEY_PATH_HKLM = 'HKLM\\SOFTWARE\\Policies\\Mercury'
export const WINDOWS_REGISTRY_KEY_PATH_HKCU = 'HKCU\\SOFTWARE\\Policies\\Mercury'
export const WINDOWS_REGISTRY_VALUE_NAME = 'Settings'

export const PLUTIL_PATH = '/usr/bin/plutil'
export const PLUTIL_ARGS_PREFIX = ['-convert', 'json', '-o', '-', '--'] as const
export const MDM_SUBPROCESS_TIMEOUT_MS = 5000

const MANAGED_PREFERENCES_FOLDER = '/Library/Managed Preferences'

export function getMacOSPlistPaths(): Array<{ path: string; label: string }> {
  let username = ''
  try {
    username = userInfo().username
  } catch (error) {
    passedOver(error)
  }
  const device = {
    path: `${MANAGED_PREFERENCES_FOLDER}/${MACOS_PREFERENCE_DOMAIN}.plist`,
    label: `managed preferences (device, ${MACOS_PREFERENCE_DOMAIN})`,
  }
  if (!username) return [device]
  const user = {
    path: `${MANAGED_PREFERENCES_FOLDER}/${username}/${MACOS_PREFERENCE_DOMAIN}.plist`,
    label: `managed preferences (user, ${MACOS_PREFERENCE_DOMAIN})`,
  }
  return [user, device]
}
