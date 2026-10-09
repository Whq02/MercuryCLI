import type { AppState } from '../../state/AppStateStore.js'
import { refreshHooksSnapshot } from '../hooks/hooksConfigSnapshot.js'
import { loadAllPermissionRulesFromDisk } from '../permissions/permissionsLoader.js'
import {
  createSovereignDisabledContext,
  isSovereignDisabled,
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
    let toolPermissionContext = syncPermissionRulesFromDisk(prev.toolPermissionContext as never, rules) as never
    if (
      isSovereignDisabled() &&
      (toolPermissionContext as { mode?: string }).mode !== undefined
    ) {
      toolPermissionContext = createSovereignDisabledContext(toolPermissionContext as never) as never
    }

    const previousEffort = prev.settings?.engine?.effort
    const nextEffort = settings.engine?.effort
    const effortChanged = previousEffort !== nextEffort && nextEffort !== undefined

    return {
      ...prev,
      toolPermissionContext,
      settings: settings as never,
      ...(effortChanged ? { effortValue: nextEffort as never } : {}),
    }
  })
}
