
import React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from '../../entrypoints/agentSdkTypes.js'
import type { MessageLookups } from '../../utils/messages/lookups.js'
import { plural } from '../../utils/stringUtils.js'

export function HookProgressMessage({
  hookEvent,
  toolUseID,
  lookups,
  isTranscriptMode = false,
}: {
  hookEvent: HookEvent
  toolUseID: string
  lookups: MessageLookups
  isTranscriptMode?: boolean
}): React.ReactNode {
  const inProgress =
    lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  if (inProgress === 0) return null
  const resolved =
    lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0

  if (hookEvent === 'PreToolUse' || hookEvent === 'PostToolUse') {
    if (!isTranscriptMode) return null
    return (
      <Text dimColor>
        Ran {inProgress} <Text bold>{hookEvent}</Text>{' '}
        {plural(inProgress, 'hook')}
      </Text>
    )
  }

  if (resolved >= inProgress) return null
  return (
    <Text dimColor>
      Running <Text bold>{hookEvent}</Text> {plural(inProgress, 'hook')}…
    </Text>
  )
}

export default HookProgressMessage
