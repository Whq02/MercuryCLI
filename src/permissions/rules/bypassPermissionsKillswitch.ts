import type { ToolPermissionContext } from '../../tools/kit/tool.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import { useRef } from 'react'
import { useLoad } from '../../screen/effects/effects.js'
import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { enqueueNotification } from '../../screen/notifications/notifications.js'
import { useAppState, useSetAppState } from '../../screen/app-state/AppState.js'
import { modeBypassesPermissions } from './permissionMode.js'
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
  useLoad(() => {
    if (started.current) return
    started.current = true
    if (getIsRemoteMode()) return
    void checkAndDisableSovereignIfNeeded(toolPermissionContext, setAppState)
  }, [])
}
