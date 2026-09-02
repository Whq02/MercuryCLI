
import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import stripAnsi from 'strip-ansi'
import { MessageResponse } from '../MessageResponse.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { formatFileSize } from '../../utils/format.js'
import { ShellTimeDisplay } from './ShellTimeDisplay.js'

const TAIL_LINES = 5

export function reserveShellRows(shown: number, latched: number): { latch: number; pad: number } {
  const latch = Math.min(TAIL_LINES, Math.max(shown, latched))
  return { latch, pad: latch - shown }
}

export function ShellProgressMessage({
  output,
  fullOutput,
  elapsedTimeSeconds,
  totalLines,
  totalBytes,
  timeoutMs,
  taskId,
  verbose,
}: {
  output: string
  fullOutput: string
  elapsedTimeSeconds?: number
  totalLines?: number
  totalBytes?: number
  timeoutMs?: number
  taskId?: string
  verbose: boolean
}): React.ReactNode {
  void taskId
  const shownLatchRef = useRef(0)
  const incremental = stripAnsi(output).trim()
  const full = stripAnsi(fullOutput).trim()

  const time = (
    <ShellTimeDisplay
      elapsedTimeSeconds={elapsedTimeSeconds}
      timeoutMs={timeoutMs}
    />
  )

  if (verbose) {
    return (
      <OffscreenFreeze>
        <MessageResponse>
          <Box flexDirection="column">
            {full !== '' ? <Text>{full}</Text> : null}
            <Box gap={1}>
              <Text dimColor>running…</Text>
              {time}
              {totalBytes !== undefined ? (
                <Text dimColor>{formatFileSize(totalBytes)}</Text>
              ) : null}
            </Box>
          </Box>
        </MessageResponse>
      </OffscreenFreeze>
    )
  }

  const lines = incremental.split('\n').filter(line => line.trim() !== '')
  const shown = lines.slice(-TAIL_LINES)
  const { latch, pad } = reserveShellRows(shown.length, shownLatchRef.current)
  shownLatchRef.current = latch

  if (latch === 0) {
    return (
      <OffscreenFreeze>
        <MessageResponse>
          <Box gap={1}>
            <Text dimColor>running…</Text>
            {time}
          </Box>
        </MessageResponse>
      </OffscreenFreeze>
    )
  }

  const caption =
    totalBytes !== undefined && totalLines !== undefined
      ? `~${totalLines} lines`
      : lines.length > shown.length
        ? `+${lines.length - shown.length} lines`
        : null

  return (
    <OffscreenFreeze>
      <MessageResponse>
        <Box flexDirection="column" height={latch + 1} overflowY="hidden">
          <Box flexDirection="column">
            {shown.map((line, index) => (
              <Text key={index} wrap="truncate-end">
                {line}
              </Text>
            ))}
            {
}
            {Array.from({ length: pad }, (_, index) => (
              <Text key={`pad-${index}`}> </Text>
            ))}
          </Box>
          <Box gap={1}>
            {caption !== null ? <Text dimColor>{caption}</Text> : null}
            {time}
            {totalBytes !== undefined ? (
              <Text dimColor>{formatFileSize(totalBytes)}</Text>
            ) : null}
          </Box>
        </Box>
      </MessageResponse>
    </OffscreenFreeze>
  )
}
