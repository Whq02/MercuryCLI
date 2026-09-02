import type { AppState } from '../../state/AppStateStore.js'
import { updateHooksConfigSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
  transitionPlanAutoMode,
} from '../permissions/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../permissions/permissions.js'
import type { SettingSource } from './constants.js'
import { getInitialSettings } from './settings.js'

export function applySettingsChange(
  source: SettingSource,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  void source
  const settings = getInitialSettings()
  const rules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()
  setAppState(prev => {
    let toolPermissionContext = syncPermissionRulesFromDisk(prev.toolPermissionContext as never, rules) as never
    if (
      isBypassPermissionsModeDisabled() &&
      (toolPermissionContext as { mode?: string }).mode !== undefined
    ) {
      toolPermissionContext = createDisabledBypassPermissionsContext(toolPermissionContext as never) as never
    }
    toolPermissionContext = transitionPlanAutoMode(toolPermissionContext as never) as never

    const previousEffort = (prev.settings as { effortLevel?: string } | undefined)?.effortLevel
    const nextEffort = settings.effortLevel
    const effortChanged = previousEffort !== nextEffort && nextEffort !== undefined

    return {
      ...prev,
      toolPermissionContext,
      settings: settings as never,
      ...(effortChanged ? { effortValue: nextEffort as never } : {}),
    }
  })
}
