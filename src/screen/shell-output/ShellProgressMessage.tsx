import React, { useRef } from 'react'
import { Box, Text } from '../themedRenderer.js'
import stripAnsi from 'strip-ansi'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'
import { OffscreenFreeze } from '../messages/OffscreenFreeze.js'
import { formatFileSize } from '../../platform/text/format.js'
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
  const latchedRef = useRef(0)
  const taskIdRef = useRef(taskId)
  if (taskIdRef.current !== taskId) {
    taskIdRef.current = taskId
    latchedRef.current = 0
  }

  const cleanOutput = stripAnsi(output).trim()
  const cleanFullOutput = stripAnsi(fullOutput).trim()
  const time = <ShellTimeDisplay elapsedTimeSeconds={elapsedTimeSeconds} timeoutMs={timeoutMs} />

  if (verbose) {
    return (
      <OffscreenFreeze>
        <MessageResponse>
          <Box flexDirection="column">
            {cleanFullOutput.length > 0 ? <Text>{cleanFullOutput}</Text> : null}
            <Box gap={1}>
              <Text dimColor>running…</Text>
              {time}
              {totalBytes !== undefined && totalBytes > 0 ? (
                <Text dimColor>{formatFileSize(totalBytes)}</Text>
              ) : null}
            </Box>
          </Box>
        </MessageResponse>
      </OffscreenFreeze>
    )
  }

  const lines =
    cleanOutput === '' ? [] : cleanOutput.split(/\r?\n/).filter(line => line.trim() !== '')
  const shown = lines.slice(-TAIL_LINES)
  const { latch, pad } = reserveShellRows(shown.length, latchedRef.current)
  latchedRef.current = latch

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
      <MessageResponse height={latch + 1}>
        <Box flexDirection="column" height={latch + 1} overflowY="hidden">
          {shown.map((line, index) => (
            <Text key={index} wrap="truncate-end">
              {line}
            </Text>
          ))}
          {Array.from({ length: pad }, (_, index) => (
            <Text key={`pad-${index}`}> </Text>
          ))}
          <Box gap={1}>
            {caption !== null ? <Text dimColor>{caption}</Text> : null}
            {time}
            {totalBytes !== undefined && totalBytes > 0 ? (
              <Text dimColor>{formatFileSize(totalBytes)}</Text>
            ) : null}
          </Box>
        </Box>
      </MessageResponse>
    </OffscreenFreeze>
  )
}
