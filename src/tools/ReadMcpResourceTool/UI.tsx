import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ToolCardMarker, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { Box, Text } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'
import type { Output } from './ReadMcpResourceTool.js'
import { notBuilt } from '../../pi/holes.js'


export function userFacingName(): string {
  return notBuilt('src/tools/ReadMcpResourceTool/UI.tsx:11')
}

export function renderToolUseMessage(input?: { server?: string; uri?: string }): React.ReactNode {
  return notBuilt('src/tools/ReadMcpResourceTool/UI.tsx:15')
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  arg2: { verbose: boolean },
): React.ReactNode {
  return notBuilt('src/tools/ReadMcpResourceTool/UI.tsx:20')
}
