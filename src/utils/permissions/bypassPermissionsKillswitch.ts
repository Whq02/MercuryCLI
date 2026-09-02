/**
 * Run-once org-policy check that revokes bypass-permissions availability, plus
 * a parallel (currently inert) auto-mode gate hook.
 */
import type { ToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { enqueueNotification } from '../../context/notifications.js'
import { useAppState, useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { modeBypassesPermissions } from './PermissionMode.js'
import {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
} from './permissionSetup.js'

/** The app-state setter; its updater operates on the whole AppState. */
type SetAppState = (updater: (prev: AppState) => AppState) => void

let bypassCheckRan = false

/** Reset so the bypass check re-runs after a login (the org may differ). */
export function resetBypassPermissionsCheck(): void {
  bypassCheckRan = false
}

/**
 * Run-once bypass killswitch: skip if already run or if bypass isn't
 * available on the context; otherwise consult the security-restriction gate
 * and, when it disables, replace the context with the "bypass disabled" form.
 */
export async function checkAndDisableBypassPermissionsIfNeeded(
  context: ToolPermissionContext,
  setAppState: SetAppState,
): Promise<void> {
  if (bypassCheckRan) return
  if (!context.isBypassPermissionsModeAvailable) return
  bypassCheckRan = true
  if (isBypassPermissionsModeDisabled()) {
    // The setter is APP-level; the disable transform is context-scoped —
    // wrap here so every caller passes its plain app-state setter.
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: createDisabledBypassPermissionsContext(prev.toolPermissionContext),
    }))
    // C7 disclosure: this flips a LIVE session's posture — say so. The mode
    // fact reads from the caller's context (the mount-time truth), never a
    // capture inside the updater (React batching defers those).
    enqueueNotification(setAppState, {
      key: 'bypass-killswitch',
      text: modeBypassesPermissions(context.mode)
        ? "bypass permissions was turned off by your organization's security policy — this session's mode is reset to default"
        : "bypass permissions was turned off by your organization's security policy",
      priority: 'high',
      color: 'warning',
      timeoutMs: 30_000,
    })
  }
}

/** A React hook that kicks off the bypass check once on mount (never in remote mode). */
export function useKickOffCheckAndDisableBypassPermissionsIfNeeded(): void {
  const toolPermissionContext = useAppState(
    state => state.toolPermissionContext as ToolPermissionContext,
  )
  const setAppState = useSetAppState()
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (getIsRemoteMode()) return
    void checkAndDisableBypassPermissionsIfNeeded(toolPermissionContext, setAppState)
    // Mount-only by contract; the context is the one read at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

let autoModeGateCheckRan = false

/** Reset the auto-mode gate check. */
export function resetAutoModeGateCheck(): void {
  autoModeGateCheckRan = false
}

/**
 * The parallel auto-mode gate check. Inert in this build (an empty body), so
 * its run-once flag is never set.
 */
export async function checkAndDisableAutoModeIfNeeded(
  _context: ToolPermissionContext,
  _setAppState: SetAppState,
): Promise<void> {
  // Inert in this build.
}

/**
 * A React hook firing the auto-mode gate check on mount and again on model /
 * per-session-model changes, calling reset on every run except
 * the first. Does nothing in remote mode. The CHECK body stays inert in this
 * build — the wiring is what must exist.
 */
export function useKickOffCheckAndDisableAutoModeIfNeeded(): void {
  const mainLoopModel = useAppState(state => state.mainLoopModel)
  const mainLoopModelForSession = useAppState(state => state.mainLoopModelForSession)
  const setAppState = useSetAppState()
  const store = useAppStateStore()
  const firstRun = useRef(true)
  useEffect(() => {
    if (getIsRemoteMode()) return
    if (!firstRun.current) {
      resetAutoModeGateCheck()
    }
    firstRun.current = false
    void checkAndDisableAutoModeIfNeeded(
      store.getState().toolPermissionContext as ToolPermissionContext,
      setAppState,
    )
    // Keyed on exactly the two subscribed inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainLoopModel, mainLoopModelForSession])
}
