import { decodePermissionModeSpelling, type PermissionMode } from '../../types/permissions.js'
import { getGlobalConfig } from '../config.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import { getSettingsForSource } from '../settings/settings.js'
import { isAutoModeGateEnabled } from './permissionSetup.js'

// ============================================================================
// shouldShowAutoDefaultNudge — the gate for the one-shot "make Flow your
// default permission mode?" dialog (AutoDefaultNudgeDialog).
// ----------------------------------------------------------------------------
// The nudge targets exactly one population: users who have EXPLICITLY pinned
// a non-flow default in their user settings, in a session where flow is
// actually available, with no higher-precedence source pinning a default of
// its own (a project/local/policy pin would win regardless, so nudging the
// user setting would mislead). The "seen" flag is persisted by the dialog on
// either answer, so the gate fires at most once ever.
// ============================================================================

const OTHER_SOURCES = SETTING_SOURCES.filter(s => s !== 'userSettings')

/**
 * Null means don't show the nudge. A mode value means show it — and the
 * value is the mode the user currently defaults to, which the dialog quotes
 * inside its decline option. Every one of these must hold:
 *   onboarding finished · never nudged before · flow is available in this
 *   session · the user's own settings name a default mode ≠ 'flow' · no
 *   other source names one at all.
 */
export function shouldShowAutoDefaultNudge(): PermissionMode | null {
  const config = getGlobalConfig()
  if (
    config.hasCompletedOnboarding !== true ||
    config.hasSeenAutoDefaultNudge === true ||
    !isAutoModeGateEnabled()
  ) {
    return null
  }

  // A raw settings read: decode a retired spelling through the bounded alias
  // BEFORE comparing or returning it (an old settings file must behave — and
  // be quoted in the dialog — as its new id).
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
