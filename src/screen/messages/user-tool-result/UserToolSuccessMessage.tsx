import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import {
  filterToolProgressMessages,
  safeUserFacingName,
  type Tool,
  type Tools,
} from '../../../tools/kit/tool.js'
import type {
  NormalizedUserMessage,
  ProgressMessage,
} from '../../../engine/message-shapes/message.js'
import type { MessageLookups } from '../../../engine/messages/lookups.js'
import { summarizeToolResult } from '../../../tools/kit/toolResultSummary.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { getTheme } from '../../theme/theme.js'
import { useTheme } from '../../theme/ThemeProvider.js'
import { RowErrorBoundary } from '../RowErrorBoundary.js'
import { HookProgressMessage } from '../HookProgressMessage.js'
import { OutputLine } from '../../shell-output/OutputLine.js'
import { BASH_TOOL_NAME } from '../../../tools/kit/names/bash.js'

function extractRawBashResultText(
  message: NormalizedUserMessage,
  toolUseID: string,
): string | null {
  const content = message.message.content
  if (!Array.isArray(content)) return null
  const block = content.find(
    item => item.type === 'tool_result' && item.tool_use_id === toolUseID,
  )
  if (!block || block.type !== 'tool_result') return null
  if (typeof block.content === 'string') return block.content
  if (Array.isArray(block.content)) {
    return block.content
      .filter(
        (part): part is { type: 'text'; text: string } =>
          typeof part === 'object' &&
          part !== null &&
          part.type === 'text' &&
          typeof part.text === 'string',
      )
      .map(part => part.text)
      .join('\n')
  }
  return null
}

export function UserToolSuccessMessage({
  message,
  lookups,
  toolUseID,
  progressMessagesForMessage,
  style,
  tool,
  tools,
  verbose,
  width,
  isTranscriptMode,
}: {
  message: NormalizedUserMessage
  lookups: MessageLookups
  toolUseID: string
  progressMessagesForMessage: ProgressMessage[]
  style?: 'condensed'
  tool: Tool
  tools: Tools
  verbose: boolean
  width: number | string
  isTranscriptMode?: boolean
}): React.ReactNode {
  const [themeName] = useTheme()
  const toolUse = lookups.toolUseByToolUseID.get(toolUseID)
  const toolInput = toolUse?.input
  const boxWidth = safeUserFacingName(tool, toolInput) === '' ? undefined : width

  if (message.toolUseResult == null) {
    if (tool.name !== BASH_TOOL_NAME) return null
    const rawText = extractRawBashResultText(message, toolUseID)
    if (rawText === null || rawText.trim() === '') return null
    return (
      <Box flexDirection="column" width={boxWidth}>
        <RowErrorBoundary>
          <Box flexDirection="column">
            <OutputLine
              content={rawText}
              verbose={Boolean(verbose || isTranscriptMode)}
            />
          </Box>
        </RowErrorBoundary>
      </Box>
    )
  }

  let data: unknown = message.toolUseResult
  if (tool.outputSchema) {
    const parsed = tool.outputSchema.safeParse(data)
    if (!parsed.success) return null
    data = parsed.data
  }

  if (
    !verbose &&
    !isTranscriptMode &&
    summarizeToolResult(toolUse?.name ?? tool.name, message.toolUseResult, toolInput) !== null
  ) {
    return null
  }

  let rendered: React.ReactNode = null
  if (typeof tool.renderToolResultMessage === 'function') {
    try {
      rendered = tool.renderToolResultMessage(
        data,
        filterToolProgressMessages(progressMessagesForMessage),
        {
          style,
          theme: getTheme(themeName),
          tools,
          verbose,
          isTranscriptMode,
          input: toolInput,
          width,
        },
      )
    } catch (error) {
      logError(error)
      rendered = null
    }
  }

  let resultNode: React.ReactNode = rendered
  if (
    typeof rendered === 'string' ||
    typeof rendered === 'number' ||
    typeof rendered === 'bigint'
  ) {
    const text = String(rendered)
    resultNode = text.length > 0 ? <Text>{text}</Text> : null
  }

  return (
    <Box flexDirection="column" width={boxWidth}>
      <RowErrorBoundary>{resultNode}</RowErrorBoundary>
      <RowErrorBoundary>
        <HookProgressMessage
          hookEvent="tool.after"
          toolUseID={toolUseID}
          lookups={lookups}
          progress={progressMessagesForMessage}
          isTranscriptMode={isTranscriptMode}
        />
      </RowErrorBoundary>
    </Box>
  )
}
