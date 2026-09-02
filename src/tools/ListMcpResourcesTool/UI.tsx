import * as React from 'react'

import { MessageResponse } from '../../components/MessageResponse.js'
import { OutputLine } from '../../components/shell/OutputLine.js'
import { ToolCardMarker, toolCardCountColor } from '../../components/mercury-ui/toolCardMeta.js'
import { useMercuryTokens } from '../../components/mercury-ui/useMercuryTokens.js'
import { Box, Text } from '../../ink.js'
import { plural } from '../../utils/stringUtils.js'
import type { Output } from './ListMcpResourcesTool.js'

/**
 * Renderers for the MCP resource listing.
 */

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
          Found{' '}
          <Text bold color={toolCardCountColor()}>
            {output.length}
          </Text>{' '}
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
