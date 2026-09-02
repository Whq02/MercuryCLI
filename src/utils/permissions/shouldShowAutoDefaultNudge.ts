import { decodePermissionModeSpelling, type PermissionMode } from '../../types/permissions.js'
import { getGlobalConfig } from '../config.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import { isAutoModeGateEnabled } from './permissionSetup.js'


const OTHER_SOURCES = SETTING_SOURCES.filter(s => s !== 'userSettings')

export function shouldShowAutoDefaultNudge(): PermissionMode | null {
  const config = getGlobalConfig()
  if (
    config.hasCompletedOnboarding !== true ||
    config.hasSeenAutoDefaultNudge === true ||
    !isAutoModeGateEnabled()
  ) {
    return null
  }

  const rawUserDefaultMode =
    getSettingsForSource('userSettings')?.permissions?.defaultMode
  const userDefaultMode = rawUserDefaultMode
    ? decodePermissionModeSpelling(rawUserDefaultMode)
    : rawUserDefaultMode
  const pinnedByOtherSource = OTHER_SOURCES.some(
    source => getSettingsForSource(source)?.permissions?.defaultMode,
  )

  if (userDefaultMode && userDefaultMode !== 'flow' && !pinnedByOtherSource) {
    return userDefaultMode as PermissionMode
  }
  return null
}
