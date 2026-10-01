import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { notifyPermissionModeChanged } from '../utils/sessionState.js'
import { auditModeChange } from '../utils/permissions/modeTransitions.js'
import { noteRootSovereign } from '../utils/permissions/rootNotice.js'
import { setMainLoopModelOverride } from '../bootstrap/state.js'
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

  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      updateSettingsForSource('userSettings', { model: undefined })
      setMainLoopModelOverride(undefined)
    } else {
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
      setMainLoopModelOverride(newState.mainLoopModel)
    }
  }

  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTasks = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'crewmates'
    const config = getGlobalConfig()
    if (
      config.showExpandedTasks !== showExpandedTasks ||
      config.showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTasks,
        showSpinnerTree,
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
      if (newState.settings?.env !== oldState.settings?.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(error)
    }
  }

}
