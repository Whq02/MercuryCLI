import * as React from 'react'
import {
  filterToolProgressMessages,
  type Tool,
  type Tools,
} from '../../../Tool.js'
import type { ProgressMessage } from '../../../types/message.js'
import type { MessageLookups } from '../../../services/messages/lookups.js'
import { getTheme } from '../../../utils/theme.js'
import { useTheme } from '../../design-system/ThemeProvider.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { FallbackToolUseRejectedMessage } from '../../FallbackToolUseRejectedMessage.js'
import { notBuilt } from '../../../pi/holes.js'

export function UserToolRejectMessage(arg0: {
  input: Record<string, unknown>
  progressMessagesForMessage: ProgressMessage[]
  tool: Tool
  tools: Tools
  lookups: MessageLookups
  style?: 'condensed'
  verbose: boolean
  isTranscriptMode?: boolean
}): React.ReactNode {
  return notBuilt('src/components/messages/UserToolResultMessage/UserToolRejectMessage.tsx:15')
}
