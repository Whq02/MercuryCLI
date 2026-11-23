import * as React from 'react'
import { useModalOrTerminalSize } from '../overlays/modalContext.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { Box, Text } from '../themedRenderer.js'
import { ComposerHelpMenu } from '../composer/ComposerHelpMenu.js'

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
        <ComposerHelpMenu gap={2} fixedWidth availableColumns={Math.max(20, columns - 4)} />
      </Box>
    </Box>
  )
}
