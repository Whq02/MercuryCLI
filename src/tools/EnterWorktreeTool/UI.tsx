// EnterWorktree rows.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Output } from './EnterWorktreeTool.js'

export function renderToolUseMessage(): React.ReactNode {
  return <Text dimColor>Creating worktree…</Text>
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (!output) return null
  return (
    <Box flexDirection="column">
      <Text>
        Entered worktree{' '}
        <Text bold>{output.worktreeBranch ?? output.worktreePath}</Text>
      </Text>
      <Text dimColor>{output.worktreePath}</Text>
    </Box>
  )
}
