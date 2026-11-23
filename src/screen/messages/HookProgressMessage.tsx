import React from 'react'
import { Text } from '../themedRenderer.js'
import type { HookEvent } from '../../integrations/event-hooks/contract.js'
import { hookWaitLineOf } from '../../integrations/event-hooks/wait.js'
import type { MessageLookups } from '../../engine/messages/lookups.js'
import type { ProgressMessage } from '../../engine/message-shapes/message.js'
import { plural } from '../../platform/text/strings.js'

export function HookProgressMessage({
  hookEvent,
  toolUseID,
  lookups,
  progress = [],
  isTranscriptMode = false,
}: {
  hookEvent: HookEvent
  toolUseID: string
  lookups: MessageLookups
  progress?: readonly ProgressMessage[]
  isTranscriptMode?: boolean
}): React.ReactNode {
  const waitLine = hookWaitLineOf(progress)
  if (waitLine !== null) {
    return <Text dimColor>{waitLine}</Text>
  }
  const started = lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  const resolved = lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  if (started > resolved) {
    return (
      <Text dimColor>
        running {started} <Text bold>{hookEvent}</Text> {plural(started, 'hook')}…
      </Text>
    )
  }
  if (isTranscriptMode && resolved > 0) {
    return (
      <Text dimColor>
        ran {resolved} <Text bold>{hookEvent}</Text> {plural(resolved, 'hook')}
      </Text>
    )
  }
  return null
}

export default HookProgressMessage
