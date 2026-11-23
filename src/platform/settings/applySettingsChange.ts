import type { AppState } from '../../screen/app-state/AppStateStore.js'
import { refreshHooksSnapshot } from '../../integrations/event-hooks/hooksConfigSnapshot.js'
import { loadAllPermissionRulesFromDisk } from '../../permissions/rules/permissionsLoader.js'
import {
  createSovereignDisabledContext,
  isSovereignDisabled,
  stripDangerousPermissionsForFlow,
} from '../../permissions/rules/permissionSetup.js'
import { syncPermissionRulesFromDisk } from '../../permissions/rules/permissionDoor.js'
import type { SettingSource } from './settingSources.js'
import { getInitialSettings } from './settings.js'

export function applySettingsChange(
  _source: SettingSource,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  const newSettings = getInitialSettings()
  const diskRules = loadAllPermissionRulesFromDisk()
  refreshHooksSnapshot()

  setAppState(prev => {
    let toolPermissionContext = syncPermissionRulesFromDisk(prev.toolPermissionContext, diskRules)
    if (isSovereignDisabled() && toolPermissionContext.mode !== undefined) {
      toolPermissionContext = createSovereignDisabledContext(toolPermissionContext)
    }
    if (toolPermissionContext.mode === 'flow') {
      toolPermissionContext = stripDangerousPermissionsForFlow(toolPermissionContext)
    }
    const nextEffort = newSettings.engine?.effort
    const effortChanged = nextEffort !== undefined && nextEffort !== prev.settings?.engine?.effort
    return {
      ...prev,
      settings: newSettings,
      toolPermissionContext,
      ...(effortChanged ? { effortValue: nextEffort } : {}),
    }
  })
}
