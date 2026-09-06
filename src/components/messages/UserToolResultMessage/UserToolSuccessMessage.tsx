
import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import {
  filterToolProgressMessages,
  safeUserFacingName,
  type Tool,
  type Tools,
} from '../../../Tool.js'
import type {
  NormalizedUserMessage,
  ProgressMessage,
} from '../../../types/message.js'
import type { MessageLookups } from '../../../utils/messages/lookups.js'
import {
  deleteClassifierApproval,
  getClassifierApproval,
  getYoloClassifierApproval,
} from '../../../utils/classifierApprovals.js'
import { summarizeToolResult } from '../../../utils/toolResultSummary.js'
import { logError } from '../../../utils/log.js'
import { getTheme } from '../../../utils/theme.js'
import { useTheme } from '../../design-system/ThemeProvider.js'
import { RowErrorBoundary } from '../../RowErrorBoundary.js'
import { HookProgressMessage } from '../HookProgressMessage.js'

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
  useState(() => {
    const captured =
      getClassifierApproval(toolUseID) ?? getYoloClassifierApproval(toolUseID)
    deleteClassifierApproval(toolUseID)
    return captured ?? null
  })

  const result = message.toolUseResult
  if (result === undefined || result === null) return null

  let validated: unknown = result
  if (tool.outputSchema) {
    const parsed = tool.outputSchema.safeParse(result)
    if (!parsed.success) return null
    validated = parsed.data
  }

  if (!verbose && !isTranscriptMode) {
    const blockName =
      lookups.toolUseByToolUseID.get(toolUseID)?.name ?? tool.name
    if (summarizeToolResult(blockName, result) !== null) return null
  }

  const toolUseBlock = lookups.toolUseByToolUseID.get(toolUseID)
  let rendered: React.ReactNode
  try {
    rendered = tool.renderToolResultMessage?.(
      validated,
      filterToolProgressMessages(progressMessagesForMessage),
      {
        style,
        theme: getTheme(themeName),
        tools,
        verbose,
        isTranscriptMode,
        input: toolUseBlock?.input,
        width,
      },
    )
  } catch (error) {
    logError(error)
    rendered = null
  }
  if (
    typeof rendered === 'string' ||
    typeof rendered === 'number' ||
    typeof rendered === 'bigint'
  ) {
    rendered = String(rendered) === '' ? null : <Text>{String(rendered)}</Text>
  }

  const unconstrained = safeUserFacingName(tool, toolUseBlock?.input) === ''

  return (
    <Box flexDirection="column" width={unconstrained ? undefined : width}>
      {
}
      <RowErrorBoundary>{rendered ?? null}</RowErrorBoundary>
      <RowErrorBoundary>
        <HookProgressMessage
          hookEvent="PostToolUse"
          toolUseID={toolUseID}
          lookups={lookups}
          isTranscriptMode={isTranscriptMode}
        />
      </RowErrorBoundary>
    </Box>
  )
}
