import * as React from 'react'
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
import type { MessageLookups } from '../../../services/messages/lookups.js'
import { summarizeToolResult } from '../../../tools/toolResultSummary.js'
import { logError } from '../../../utils/log.js'
import { getTheme } from '../../../utils/theme.js'
import { useTheme } from '../../design-system/ThemeProvider.js'
import { RowErrorBoundary } from '../../RowErrorBoundary.js'
import { HookProgressMessage } from '../HookProgressMessage.js'
import { OutputLine } from '../../shell/OutputLine.js'
import { BASH_TOOL_NAME } from '../../../constants/tools/bash.js'
import { notBuilt } from '../../../pi/holes.js'

export function UserToolSuccessMessage(arg0: {
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
  return notBuilt('src/components/messages/UserToolResultMessage/UserToolSuccessMessage.tsx:24')
}
