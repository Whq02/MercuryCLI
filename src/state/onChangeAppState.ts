import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
} from '../utils/sessionState.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import { auditModeChange } from '../utils/permissions/modeTransitions.js'
import type { SessionExternalMetadata } from '../utils/sessionState.js'
import { setMainLoopModelOverride } from '../bootstrap/state.js'
import { getUserContext } from '../context.js'
import { syncInstructionRootsWithWorkspace } from '../services/instructions/engine.js'
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
    const newExternal = toExternalPermissionMode(newMode)
    const oldExternal = toExternalPermissionMode(oldMode)
    if (newExternal !== oldExternal) {
      const ultraplanIndicator =
        newMode === 'strategy' &&
        newState.isUltraplanMode === true &&
        oldState.isUltraplanMode !== true
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: ultraplanIndicator,
      })
    }
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
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    const config = getGlobalConfig()
    if (
      config.showExpandedTodos !== showExpandedTodos ||
      config.showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
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

  if (newState.toolPermissionContext !== oldState.toolPermissionContext) {
    try {
      if (
        syncInstructionRootsWithWorkspace(
          newState.toolPermissionContext.additionalWorkingDirectories,
        )
      ) {
        getUserContext.cache?.clear?.()
      }
    } catch (error) {
      logError(error)
    }
  }
}

export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prevState: AppState) => AppState {
  return prevState => {
    let next = prevState
    if (typeof metadata.permission_mode === 'string') {
      const mode = permissionModeFromString(metadata.permission_mode)
      if (mode !== next.toolPermissionContext.mode) {
        next = {
          ...next,
          toolPermissionContext: { ...next.toolPermissionContext, mode },
        }
      }
    }
    if (typeof metadata.is_ultraplan_mode === 'boolean') {
      if (next.isUltraplanMode !== metadata.is_ultraplan_mode) {
        next = { ...next, isUltraplanMode: metadata.is_ultraplan_mode }
      }
    }
    return next
  }
}
