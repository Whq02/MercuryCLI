import * as React from 'react'
import {
  filterToolProgressMessages,
  type Tool,
  type Tools,
} from '../../../tools/kit/tool.js'
import type { ProgressMessage } from '../../../engine/message-shapes/message.js'
import type { MessageLookups } from '../../../engine/messages/lookups.js'
import { getTheme } from '../../theme/theme.js'
import { useTheme } from '../../theme/ThemeProvider.js'
import { useTerminalSize } from '../../fullscreen-layout/useTerminalSize.js'
import { FallbackToolUseRejectedMessage } from '../../../tools/kit/FallbackToolUseRejectedMessage.js'

export function UserToolRejectMessage({
  input,
  progressMessagesForMessage,
  tool,
  tools,
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
  const [themeName] = useTheme()
  const { columns } = useTerminalSize()
  if (!tool.renderToolUseRejectedMessage) {
    return <FallbackToolUseRejectedMessage />
  }
  const parsed = tool.inputSchema.safeParse(input)
  if (!parsed.success) {
    return <FallbackToolUseRejectedMessage />
  }
  const rendered = tool.renderToolUseRejectedMessage(parsed.data, {
    columns,
    width: columns,
    progressMessagesForMessage: filterToolProgressMessages(progressMessagesForMessage),
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
