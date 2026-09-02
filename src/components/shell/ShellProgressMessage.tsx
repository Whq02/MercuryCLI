// Live shell progress block: ANSI stripped from both output forms,
// verbose shows the full output, otherwise the last 5 non-empty incremental
// lines; a "running" line when nothing has arrived. The caption states an
// approximate total when byte+line totals are known, else a "+N lines"
// overflow; verbose has no caption. Non-verbose clamps the block height.

import React, { useRef } from 'react'
import { Box, Text } from '../../ink.js'
import stripAnsi from 'strip-ansi'
import { MessageResponse } from '../MessageResponse.js'
import { OffscreenFreeze } from '../OffscreenFreeze.js'
import { formatFileSize } from '../../utils/format.js'
import { ShellTimeDisplay } from './ShellTimeDisplay.js'

const TAIL_LINES = 5

/** The block's row reserve: the streamed `output` is a
 *  ROLLING window (TaskOutput's most-recent-5 lines) and the block filtered
 *  it to non-blank per frame — blank lines rolling through shrank and
 *  regrew the height once a second, jittering the transcript around a
 *  surface the operator is trying to read. The reserve is MONOTONE for the
 *  life of one stream: grow with content, never shrink; the missing rows
 *  pad between content and the footer so the running…/time row holds the
 *  block's bottom edge still. A new tool run mounts a new instance — the
 *  latch dies with the stream. Pure and exported — prove-resize-laws
 *  drives it. */
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
  // B3: the monotone row latch — before any conditional return (hook law).
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
    // Nothing has EVER shown: the one-row running line. (A window that
    // momentarily rolls all-blank after content keeps the reserved frame
    // below — the block never collapses mid-stream.)
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
            {/* B3: the reserve's pad rows — the footer holds the bottom
                edge still while blanks roll through the window. */}
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
