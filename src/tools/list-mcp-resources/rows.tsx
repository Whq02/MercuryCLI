import * as React from 'react'

import { MessageResponse } from '../kit/MessageResponse.js'
import { OutputLine } from '../../screen/shell-output/OutputLine.js'
import { ToolCardMarker, toolCardCountColor } from '../../screen/widgets/toolCardMeta.js'
import { useMercuryTokens } from '../../screen/widgets/useMercuryTokens.js'
import { Box, Text } from '../../screen/themedRenderer.js'
import { plural } from '../../platform/text/strings.js'
import type { Output } from './ListMcpResourcesTool.js'


export function renderToolUseMessage(input?: { server?: string }): React.ReactNode {
  return input?.server ?? 'all'
}

function ResourceListCard({
  output,
  verbose,
}: {
  output: Output
  verbose: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  if (output.length === 0) {
    return (
      <MessageResponse>
        <Text color={tokens.textMuted}>no resources</Text>
      </MessageResponse>
    )
  }
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text>
          <ToolCardMarker />
          Found <Text bold color={toolCardCountColor()}>{output.length}</Text>{' '}
          {plural(output.length, 'resource')}
        </Text>
        <OutputLine content={JSON.stringify(output, null, 2)} verbose={verbose} />
      </Box>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  { verbose, isTranscriptMode }: { verbose: boolean; isTranscriptMode?: boolean },
): React.ReactNode {
  return <ResourceListCard output={output} verbose={verbose || isTranscriptMode === true} />
}
