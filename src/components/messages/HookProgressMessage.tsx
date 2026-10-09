import React from 'react'
import { Text } from '../../ink.js'
import type { HookEvent } from '../../utils/hooks/contract.js'
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
  const running = lookups.inProgressHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  const ran = lookups.resolvedHookCounts.get(toolUseID)?.get(hookEvent) ?? 0
  if (running > ran) {
    return (
      <Text dimColor>
        running {running} <Text bold>{hookEvent}</Text> {plural(running, 'hook')}…
      </Text>
    )
  }
  if (ran === 0 || !isTranscriptMode) return null
  return (
    <Text dimColor>
      ran {ran} <Text bold>{hookEvent}</Text> {plural(ran, 'hook')}
    </Text>
  )
}

export default HookProgressMessage
