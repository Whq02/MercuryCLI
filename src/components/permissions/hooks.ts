import { useEffect, useRef } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

export function usePermissionRequestLogging(toolUseConfirm: ToolUseConfirm): void {
  const setAppState = useSetAppState()
  const loggedToolUseId = useRef<string | null>(null)
  useEffect(() => {
    if (loggedToolUseId.current === toolUseConfirm.toolUseID) return
    loggedToolUseId.current = toolUseConfirm.toolUseID
    setAppState(prev => ({
      ...prev,
      attribution: {
        ...prev.attribution,
        permissionPromptCount: prev.attribution.permissionPromptCount + 1,
      },
    }))
  }, [toolUseConfirm, setAppState])
}
