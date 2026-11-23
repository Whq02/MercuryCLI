import React from 'react'
import { Text } from '../themedRenderer.js'
import { formatDuration } from '../../platform/text/format.js'

export function ShellTimeDisplay({
  elapsedTimeSeconds,
  timeoutMs,
}: {
  elapsedTimeSeconds?: number
  timeoutMs?: number
}): React.ReactNode {
  if (elapsedTimeSeconds === undefined && timeoutMs === undefined) return null

  const elapsedText =
    elapsedTimeSeconds !== undefined ? formatDuration(elapsedTimeSeconds * 1000) : undefined
  const timeoutText =
    timeoutMs !== undefined ? formatDuration(timeoutMs, { hideTrailingZeros: true }) : undefined

  if (elapsedText !== undefined && timeoutText !== undefined) {
    return (
      <Text dimColor>
        ({elapsedText} · timeout {timeoutText})
      </Text>
    )
  }
  if (timeoutText !== undefined) {
    return <Text dimColor>(timeout {timeoutText})</Text>
  }
  return <Text dimColor>({elapsedText})</Text>
}
