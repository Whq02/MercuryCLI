import * as React from 'react'
import { useModalOrTerminalSize } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { PromptInputHelpMenu } from '../PromptInput/PromptInputHelpMenu.js'

export function General(): React.ReactNode {
  const { columns } = useModalOrTerminalSize(useTerminalSize())
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      <Box>
        <Text>
          Mercury is a coding harness — it reads your codebase, edits with your consent, and runs commands, never leaving the terminal.
        </Text>
      </Box>
      <Box flexDirection="column">
        <Box>
          <Text bold>Shortcuts</Text>
        </Box>
        <PromptInputHelpMenu gap={2} fixedWidth availableColumns={Math.max(20, columns - 4)} />
      </Box>
    </Box>
  )
}
