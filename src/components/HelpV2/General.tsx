import * as React from 'react'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js'

export function General(): React.ReactNode {
  const { columns } = useModalOrTerminalSize(useTerminalSize())
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Text>
        Mercury is a coding harness — it reads your codebase, edits with your consent, and runs commands, never leaving the terminal.
      </Text>
      <Box flexDirection="column">
        <Text bold>Shortcuts</Text>
        <PromptInputHelpMenu availableColumns={columns} />
      </Box>
    </Box>
  )
}
