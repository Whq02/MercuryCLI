import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { notifyPermissionModeChanged } from '../utils/sessionState.js'
import { auditModeChange } from '../utils/permissions/modeTransitions.js'
import { noteRootSovereign } from '../utils/permissions/rootNotice.js'
import { setEngineModelOverride } from '../bootstrap/state.js'
import { clearApiKeyHelperCache } from '../utils/auth.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { logError } from '../utils/log.js'
import type { AppState } from './AppStateStore.js'

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}): void {
  const newMode = newState.toolPermissionContext.mode
  const oldMode = oldState.toolPermissionContext.mode
  if (newMode !== oldMode) {
    auditModeChange(oldMode, newMode)
    noteRootSovereign(newMode)
    notifyPermissionModeChanged(newMode)
  }

  if (newState.engineModel !== oldState.engineModel) {
    if (newState.engineModel === null) {
      updateSettingsForSource('userSettings', { engine: { model: undefined } })
      setEngineModelOverride(undefined)
    } else {
      updateSettingsForSource('userSettings', { engine: { model: newState.engineModel } })
      setEngineModelOverride(newState.engineModel)
    }
  }

  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTasks = newState.expandedView === 'tasks'
    const config = getGlobalConfig()
    if (config.showExpandedTasks !== showExpandedTasks) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTasks,
      }))
    }
  }

  if (newState.verbose !== oldState.verbose) {
    const toolOutput = newState.verbose ? 'full' : 'compact'
    if (getGlobalConfig().toolOutput !== toolOutput) {
      saveGlobalConfig(current => ({ ...current, toolOutput }))
    }
  }

  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      if (newState.settings?.environment?.values !== oldState.settings?.environment?.values) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(error)
    }
  }

}
