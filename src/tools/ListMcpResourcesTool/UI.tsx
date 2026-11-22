import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ToolCardMarker, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { Box, Text } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'
import type { Output } from './ListMcpResourcesTool.js'
import { notBuilt } from '../../pi/holes.js'


export function renderToolUseMessage(input?: { server?: string }): React.ReactNode {
  return input?.server ?? 'all'
}

function ResourceListCard(arg0: {
  output: Output
  verbose: boolean
}): React.ReactNode {
  return notBuilt('src/tools/ListMcpResourcesTool/UI.tsx:16')
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  { verbose, isTranscriptMode }: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  return <ResourceListCard output={output} verbose={verbose || isTranscriptMode === true} />
}
