// A rejected tool call, rendered by the tool's own rejection renderer when it
// has one and the input still validates — otherwise the shared generic
// rejection element. This path never renders an empty row.

import * as React from 'react'
import {
  filterToolProgressMessages,
  type Tool,
  type Tools,
} from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import type { MessageLookups } from '../../../utils/messages/lookups.js'
import { getTheme } from '../../../utils/theme.js'
import { useTheme } from '../../design-system/ThemeProvider.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { FallbackToolUseRejectedMessage } from '../../FallbackToolUseRejectedMessage.js'

export function UserToolRejectMessage({
  input,
  progressMessagesForMessage,
  tool,
  tools,
  lookups,
  style,
  verbose,
  isTranscriptMode,
}: {
  input: Record<string, unknown>
  progressMessagesForMessage: ProgressMessage[]
  tool: Tool
  tools: Tools
  lookups: MessageLookups
  style?: 'condensed'
  verbose: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const [themeName] = useTheme()
  void lookups

  if (!tool.renderToolUseRejectedMessage) {
    return <FallbackToolUseRejectedMessage />
  }

  // Resumed transcripts carry unvalidated inputs; a corrupt one must fall
  // back rather than crash the tool's renderer.
  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) {
    return <FallbackToolUseRejectedMessage />
  }

  const rendered = tool.renderToolUseRejectedMessage(parsed.data, {
    columns,
    width: columns,
    progressMessagesForMessage: filterToolProgressMessages(
      progressMessagesForMessage,
    ),
    style,
    theme: getTheme(themeName),
    tools,
    verbose,
    isTranscriptMode,
  })
  if (rendered === null || rendered === undefined) {
    return <FallbackToolUseRejectedMessage />
  }
  return rendered
}
