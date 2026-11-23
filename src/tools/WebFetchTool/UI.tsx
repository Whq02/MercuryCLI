import * as React from 'react'

import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker, ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { formatFileSize, truncate } from '../../utils/format.js'
import type { Output } from './WebFetchTool.js'

type Input = { url?: string; prompt?: string }

export function renderToolUseMessage(input: Partial<Input>, { verbose }: { verbose: boolean }): React.ReactNode {
  if (!input.url) return null
  if (!verbose) return input.url
  return [`url: ${input.url}`, ...(input.prompt ? [`prompt: ${input.prompt}`] : [])].join('\n')
}

function FetchingIndicator(): React.ReactElement {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Fetching…</Text>
    </MessageResponse>
  )
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return <FetchingIndicator />
}

export function renderToolResultMessage(
  output: Output,
  _progress: unknown,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const statusMeta = output.codeText ? `${output.code} ${output.codeText}` : String(output.code)
  const summary = (
    <MessageResponse>
      <Text>
        <ToolCardMarker />
        Received{' '}
        <Text bold color={toolCardCountColor()}>
          {formatFileSize(output.bytes)}
        </Text>
        <ToolCardMeta text={statusMeta} />
      </Text>
    </MessageResponse>
  )
  if (!verbose) return summary
  return (
    <Box flexDirection="column">
      {summary}
      <Text>{output.result}</Text>
    </Box>
  )
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  if (!input?.url) return null
  return truncate(input.url, TOOL_SUMMARY_MAX_LENGTH)
}
