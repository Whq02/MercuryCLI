
import React from 'react'
import { basename } from 'path'
import { Text } from '../ink.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import { GLYPH } from './mercury-ui/glyphs.js'
import { plural } from '../utils/stringUtils.js'

export function IdeStatusIndicator({
  ideSelection,
  mcpClients,
}: {
  ideSelection: IDESelection | undefined
  mcpClients?: MCPServerConnection[]
}): React.ReactNode {
  const connected = (mcpClients ?? []).some(
    client => client.name === 'ide' && client.type === 'connected',
  )
  if (!connected || !ideSelection) return null

  const hasSelection =
    typeof ideSelection.text === 'string' && ideSelection.lineCount > 0
  if (!hasSelection && !ideSelection.filePath) return null

  return (
    <Text dimColor wrap="truncate-end">
      {
}
      {`${GLYPH.cursor} `}
      {hasSelection
        ? `${ideSelection.lineCount} ${plural(ideSelection.lineCount, 'line')} selected`
        : basename(ideSelection.filePath!)}
    </Text>
  )
}

export default IdeStatusIndicator
