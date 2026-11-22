import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { notifyPermissionModeChanged } from '../utils/sessionState.js'
import { auditModeChange } from '../utils/permissions/modeTransitions.js'
import { noteRootSovereign } from '../utils/permissions/rootNotice.js'
import { setEngineModelOverride } from '../bootstrap/state.js'
import { clearApiKeyHelperCache } from '../utils/auth.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { logError } from '../utils/log.js'
import type { AppState } from './AppStateStore.js'
import { notBuilt } from '../pi/holes.js'

const mcpClientsListeners = new Set<() => void>()

export function subscribeMcpClientsChange(listener: () => void): () => void {
  mcpClientsListeners.add(listener)
  return () => {
    mcpClientsListeners.delete(listener)
  }
}

export function onChangeAppState(arg0: {
  newState: AppState
  oldState: AppState
}): void {
  return notBuilt('src/state/onChangeAppState.ts:20')
}
