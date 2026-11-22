import * as React from 'react'

import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { ToolCardMarker, ToolCardMeta, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { formatFileSize, truncate } from '../../utils/format.js'
import type { Output } from './WebFetchTool.js'
import { notBuilt } from '../../pi/holes.js'


type Input = { url?: string; prompt?: string }

export function renderToolUseMessage(input: Partial<Input>, { verbose }: { verbose: boolean }): React.ReactNode {
  if (!input.url) return null
  if (!verbose) return input.url
  return [`url: ${input.url}`, ...(input.prompt ? [`prompt: ${input.prompt}`] : [])].join('\n')
}

function FetchingIndicator(): React.ReactElement {
  return notBuilt('src/tools/WebFetchTool/UI.tsx:19')
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return <FetchingIndicator />
}

export function renderToolResultMessage(output: Output, _progress: unknown, arg2: { verbose: boolean }): React.ReactNode {
  return notBuilt('src/tools/WebFetchTool/UI.tsx:49')
}

export function getToolUseSummary(input: Partial<Input> | undefined): string | null {
  return notBuilt('src/tools/WebFetchTool/UI.tsx:53')
}
