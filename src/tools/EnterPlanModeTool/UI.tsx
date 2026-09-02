// Entered / declined plan-mode rows.

import * as React from 'react'
import { Box, Text } from '../../ink.js'
import type { Output } from './EnterPlanModeTool.js'

export function renderToolResultMessage(output: Output): React.ReactNode {
  void output
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">•</Text> Entered strategy mode
      </Text>
      <Text dimColor>
        Mercury is now exploring the codebase and designing an approach.
      </Text>
    </Box>
  )
}

export function renderToolUseRejectedMessage(): React.ReactNode {
  return (
    <Text>
      <Text>•</Text> Strategy mode declined
    </Text>
  )
}

export function renderToolUseMessage(): React.ReactNode {
  return null
}
