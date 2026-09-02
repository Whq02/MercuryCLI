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

/**
 * Applies a detected settings change to a live session — shared by the
 * interactive and headless/SDK paths so policy changes land in both.
 * Side effects like auth-cache clears and env application hang off the
 * state change; they are not this function's job.
 */
export function applySettingsChange(
  source: SettingSource,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): void {
  void source
  // 1. The caches were already reset centrally by the notifier.
  const settings = getInitialSettings()
  // 2. Reload permission rules and refresh the hooks snapshot.
  const rules = loadAllPermissionRulesFromDisk()
  updateHooksConfigSnapshot()
  // 3-5. State update.
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
    // Effort propagation is CONDITIONAL: only when the settings' effort
    // actually changed AND the new value is defined. Unconditional
    // propagation lets unrelated settings churn clobber a CLI-set effort;
    // propagating undefined wipes a session-scoped value (internal writes
    // suppress the watcher resync, leaving the stored settings stale).
    const effortChanged = previousEffort !== nextEffort && nextEffort !== undefined

    return {
      ...prev,
      toolPermissionContext,
      settings: settings as never,
      ...(effortChanged ? { effortValue: nextEffort as never } : {}),
    }
  })
}
