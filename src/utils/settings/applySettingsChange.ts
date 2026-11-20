import type { AppState } from '../../state/AppStateStore.js'
import { refreshHooksSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import {
  createSovereignDisabledContext,
  isSovereignDisabled,
  stripDangerousPermissionsForFlow,
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
  refreshHooksSnapshot()
  setAppState(prev => {
    let toolPermissionContext = syncPermissionRulesFromDisk(prev.toolPermissionContext, rules)
    if (
      isSovereignDisabled() &&
      toolPermissionContext.mode !== undefined
    ) {
      toolPermissionContext = createSovereignDisabledContext(toolPermissionContext)
    }
    if (toolPermissionContext.mode === 'flow') {
      toolPermissionContext = stripDangerousPermissionsForFlow(toolPermissionContext)
    }

    const previousEffort = prev.settings?.engine?.effort
    const nextEffort = settings.engine?.effort
    const effortChanged = previousEffort !== nextEffort && nextEffort !== undefined

    return {
      ...prev,
      toolPermissionContext,
      settings,
      ...(effortChanged ? { effortValue: nextEffort } : {}),
    }
  })
}
