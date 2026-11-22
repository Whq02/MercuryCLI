import { notBuilt, unbuilt, type Unbuilt } from '../../../pi/holes.js'

export const MACOS_PREFERENCE_DOMAIN: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:4')

export const WINDOWS_REGISTRY_KEY_PATH_HKLM: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:6')
export const WINDOWS_REGISTRY_KEY_PATH_HKCU: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:7')
export const WINDOWS_REGISTRY_VALUE_NAME: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:8')

export const PLUTIL_PATH: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:10')
export const PLUTIL_ARGS_PREFIX: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:11')
export const MDM_SUBPROCESS_TIMEOUT_MS: Unbuilt = unbuilt('src/utils/settings/mdm/constants.ts:12')

export function getMacOSPlistPaths(): Array<{ path: string; label: string }> {
  return notBuilt('src/utils/settings/mdm/constants.ts:16')
}
