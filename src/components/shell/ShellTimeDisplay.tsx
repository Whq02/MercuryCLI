// Elapsed/timeout parenthetical for shell progress: nothing when
// neither is known; timeout-only when elapsed is unknown; elapsed alone; or
// elapsed · timeout. Elapsed arrives in seconds, timeout in milliseconds;
// timeouts hide trailing zeros. Always dim, always parenthesised.

import React from 'react'
import { Text } from '../../ink.js'
import { formatDuration } from '../../utils/format.js'

export function ShellTimeDisplay({
  elapsedTimeSeconds,
  timeoutMs,
}: {
  elapsedTimeSeconds?: number
  timeoutMs?: number
}): React.ReactNode {
  const hasElapsed = elapsedTimeSeconds !== undefined
  const hasTimeout = timeoutMs !== undefined
  if (!hasElapsed && !hasTimeout) return null
  const timeoutText = hasTimeout ? formatDuration(timeoutMs, { hideTrailingZeros: true }) : null
  if (!hasElapsed) {
    return <Text dimColor>(timeout {timeoutText})</Text>
  }
  const elapsedText = formatDuration(elapsedTimeSeconds * 1000)
  if (!hasTimeout) {
    return <Text dimColor>({elapsedText})</Text>
  }
  return (
    <Text dimColor>
      ({elapsedText} · timeout {timeoutText})
    </Text>
  )
}
