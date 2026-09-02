// In-flight hook-count progress row for one tool use. PreToolUse and
// PostToolUse are silent in the normal view (their outcomes are summarised
// elsewhere) and render a past-tense receipt only in transcript mode; every
// other event renders a present-tense running row for as long as the
// resolved count trails the in-progress count.

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

  // The count governs pluralisation but the number itself is not printed.
  if (resolved >= inProgress) return null
  return (
    <Text dimColor>
      Running <Text bold>{hookEvent}</Text> {plural(inProgress, 'hook')}…
    </Text>
  )
}

export default HookProgressMessage
