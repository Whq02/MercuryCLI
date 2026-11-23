import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { notifyPermissionModeChanged } from '../utils/sessionState.js'
import { auditModeChange } from '../utils/permissions/modeTransitions.js'
import { noteRootSovereign } from '../utils/permissions/rootNotice.js'
import { setEngineModelOverride } from '../bootstrap/state.js'
import { clearApiKeyHelperCache } from '../utils/auth.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { logError } from '../utils/log.js'
import type { AppState } from './AppStateStore.js'

const mcpClientsListeners = new Set<() => void>()

export function subscribeMcpClientsChange(listener: () => void): () => void {
  mcpClientsListeners.add(listener)
  return () => {
    mcpClientsListeners.delete(listener)
  }
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}): void {
  if (newState.toolPermissionContext.mode !== oldState.toolPermissionContext.mode) {
    auditModeChange(oldState.toolPermissionContext.mode, newState.toolPermissionContext.mode)
    noteRootSovereign(newState.toolPermissionContext.mode)
    notifyPermissionModeChanged(newState.toolPermissionContext.mode)
  }

  if (newState.engineModel !== oldState.engineModel) {
    setEngineModelOverride(newState.engineModel ?? undefined)
  }

  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTasks = newState.expandedView === 'tasks'
    if (getGlobalConfig().showExpandedTasks !== showExpandedTasks) {
      saveGlobalConfig(current => ({ ...current, showExpandedTasks }))
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
      if (newState.settings.environment?.values !== oldState.settings.environment?.values) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(error)
    }
  }

  if (newState.mcp.clients !== oldState.mcp.clients) {
    for (const listener of mcpClientsListeners) {
      listener()
    }
  }
}
