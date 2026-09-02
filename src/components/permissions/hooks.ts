/**
 * Per-dialog consent telemetry: the prompt-count attribution bump and the
 * `response` unary event, fired exactly once per dialog instance.
 */
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
  // Deduplicated by tool-use id, scoped to this dialog instance. The guard is
  // load-bearing: the producer may hand down a NEW request object on every
  // render, and an unguarded effect keyed on it would re-run, update app
  // state, re-render, and re-run again — an unbounded render/CPU loop. A
  // remount (new dialog) starts with a fresh ref and fires again.
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
