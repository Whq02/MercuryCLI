import * as React from 'react'

import {
  ToolCardMarker,
  toolCardCountColor,
} from '../../components/mercury-ui/toolCardMeta.js'
import { Box, Text } from '../../ink.js'
import type { Output } from './ExitWorktreeTool.js'

/**
 * Transcript renderers for ExitWorktree: the progress phrase and the result
 * card. No error renderer and no search-text extractor — the framework
 * fallbacks apply.
 */

export function renderToolUseMessage(): React.ReactNode {
  return 'Exiting worktree…'
}

/** No response frame — a bare two-line column box. */
function ExitWorktreeResultCard({ output }: { output: Output }): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <ToolCardMarker />
        {output.action === 'keep' ? 'Kept worktree' : 'Removed worktree'}
        {output.worktreeBranch ? (
          <>
            {' (branch '}
            <Text bold color={toolCardCountColor()}>
              {output.worktreeBranch}
            </Text>
            {')'}
          </>
        ) : null}
      </Text>
      <Text dimColor>Returned to {output.originalCwd}</Text>
    </Box>
  )
}

export function renderToolResultMessage(
  output: Output,
  _progressMessages: unknown,
  _options: { theme?: string },
): React.ReactNode {
  return <ExitWorktreeResultCard output={output} />
}
