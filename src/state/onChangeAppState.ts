// ============================================================================
//  src/state/onChangeAppState.ts — the ONE choke point for state-change
//  side effects (mode relay, model/view/verbose persistence, settings
//  cache invalidation). Individual mutation sites must not duplicate
//  these. The permission-mode listener itself is registered in
//  src/cli/print.ts.
// ============================================================================
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
import type { SessionExternalMetadata } from '../utils/sessionState.js'
import { setMainLoopModelOverride } from '../bootstrap/state.js'
import { getUserContext } from '../context.js'
import { syncInstructionRootsWithWorkspace } from '../services/instructions/engine.js'
import { clearApiKeyHelperCache } from '../utils/auth.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import { logError } from '../utils/log.js'
import type { AppState } from './AppStateStore.js'

/**
 * Runs after every REAL state change (the store's identity short-circuit
 * filters no-ops upstream).
 */
export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}): void {
  // 1. Permission-mode relay.
  const newMode = newState.toolPermissionContext.mode
  const oldMode = oldState.toolPermissionContext.mode
  if (newMode !== oldMode) {
    const newExternal = toExternalPermissionMode(newMode)
    const oldExternal = toExternalPermissionMode(oldMode)
    if (newExternal !== oldExternal) {
      // The ultraplan indicator is true only on the transition INTO strategy
      // mode where the flag is newly set; null otherwise — which the
      // metadata protocol reads as "remove this key" (JSON merge patch).
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
    // Independently of the external comparison: the RAW internal mode
    // (the listener applies its own filtering). Consequence preserved: a
    // default → internal-only → default round trip emits no metadata
    // notification but does emit raw notifications.
    notifyPermissionModeChanged(newMode)
  }

  // 2. Model persistence.
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    if (newState.mainLoopModel === null) {
      updateSettingsForSource('userSettings', { model: undefined })
      setMainLoopModelOverride(undefined)
    } else {
      updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
      setMainLoopModelOverride(newState.mainLoopModel)
    }
  }

  // 3. Expanded-view persistence: two legacy booleans, written together,
  // and only when either differs from what is stored.
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

  // 4. Verbose persistence.
  if (newState.verbose !== oldState.verbose) {
    const config = getGlobalConfig()
    if (config.verbose !== newState.verbose) {
      saveGlobalConfig(current => ({ ...current, verbose: newState.verbose }))
    }
  }

  // 5. Settings-change cache invalidation. Errors here are logged, never
  // propagated.
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      if (newState.settings?.env !== oldState.settings?.env) {
        // Additive: variables are added or overwritten, never deleted.
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(error)
    }
  }

  // 6. Workspace directories → instruction roots. Every path that widens or
  // narrows the workspace (the /add-dir command, the /permissions workspace
  // tab, an accepted "add this directory" permission suggestion, a teammate
  // or SDK update, the removal dialog) lands here once; the instruction
  // engine mirrors the change into the added-directories list and resets
  // discovery, and a changed root set drops the composed user context so the
  // next turn recomposes. Errors are logged, never propagated.
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

/**
 * The inverse of the push in (1): convert inbound external session
 * metadata into a state updater, applying the permission mode (parsed from
 * its external string form) and the ultraplan flag when each is present
 * with the right primitive type. Used when a worker restarts.
 */
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
