import * as React from 'react'

import { MessageResponse } from '../kit/MessageResponse.js'
import { OutputLine } from '../../screen/shell-output/OutputLine.js'
import { ToolCardMarker, toolCardCountColor } from '../../screen/widgets/toolCardMeta.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { plural } from '../../platform/text/strings.js'
import type { Output } from './ReadMcpResourceTool.js'

export function userFacingName(): string {
  return 'readMcpResource'
}

export function renderToolUseMessage(input?: { server?: string; uri?: string }): React.ReactNode {
  if (!input?.server || !input?.uri) return null
  return `Read resource "${input.uri}" from server "${input.server}"`
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!Array.isArray(output?.contents) || output.contents.length === 0) {
    return (
      <MessageResponse>
        <Text dimColor>(No content)</Text>
      </MessageResponse>
    )
  }
  const count = output.contents.length
  return (
    <Box flexDirection="column">
      <MessageResponse>
        <Text>
          <ToolCardMarker />
          Read{' '}
          <Text bold color={toolCardCountColor()}>
            {count}
          </Text>{' '}
          {plural(count, 'item')}
        </Text>
      </MessageResponse>
      <OutputLine content={JSON.stringify(output, null, 2)} verbose={verbose} />
    </Box>
  )
}
