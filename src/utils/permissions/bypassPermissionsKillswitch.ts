import type { ToolPermissionContext } from '../../Tool.js'
import type { AppState } from '../../state/AppStateStore.js'
import { useEffect, useRef } from 'react'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { enqueueNotification } from '../../context/notifications.js'
import { useAppState, useAppStateStore, useSetAppState } from '../../state/AppState.js'
import { modeBypassesPermissions } from './PermissionMode.js'
import {
  createSovereignDisabledContext,
  isSovereignDisabled,
} from './permissionSetup.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

let bypassCheckRan = false

export function resetSovereignCheck(): void {
  bypassCheckRan = false
}

export async function checkAndDisableSovereignIfNeeded(
  context: ToolPermissionContext,
  setAppState: SetAppState,
): Promise<void> {
  if (bypassCheckRan) return
  if (!context.isBypassPermissionsModeAvailable) return
  bypassCheckRan = true
  if (isSovereignDisabled()) {
    setAppState(prev => ({
      ...prev,
      toolPermissionContext: createSovereignDisabledContext(prev.toolPermissionContext),
    }))
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

export function useKickOffCheckAndDisableSovereignIfNeeded(): void {
  const toolPermissionContext = useAppState(
    state => state.toolPermissionContext as ToolPermissionContext,
  )
  const setAppState = useSetAppState()
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    if (getIsRemoteMode()) return
    void checkAndDisableSovereignIfNeeded(toolPermissionContext, setAppState)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

let autoModeGateCheckRan = false

function resetAutoModeGateCheck(): void {
  autoModeGateCheckRan = false
}

async function checkAndDisableAutoModeIfNeeded(
  _context: ToolPermissionContext,
  _setAppState: SetAppState,
): Promise<void> {
}

export function useKickOffCheckAndDisableAutoModeIfNeeded(): void {
  const engineModel = useAppState(state => state.engineModel)
  const engineModelForSession = useAppState(state => state.engineModelForSession)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineModel, engineModelForSession])
}
