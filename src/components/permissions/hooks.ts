import { useEffect, useRef } from 'react'
import { useSetAppState } from '../../state/AppState.js'
import { env } from '../../utils/env.js'
import { logUnaryEvent, type CompletionType } from '../../utils/unaryLogging.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

export type UnaryEvent = {
  completion_type: CompletionType
  language_name: string | Promise<string>
}

export function usePermissionRequestLogging(
  toolUseConfirm: ToolUseConfirm,
  unaryEvent: UnaryEvent,
): void {
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
    void logUnaryEvent({
      event: 'response',
      completion_type: unaryEvent.completion_type,
      metadata: {
        language_name: unaryEvent.language_name,
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
  }, [toolUseConfirm, unaryEvent, setAppState])
}
