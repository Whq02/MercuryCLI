import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { SelectMulti } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../utils/mcp/types.js'
import { recordProjectMcpServerChoices } from '../services/mcp/utils.js'
import { notBuilt } from '../pi/holes.js'

export function MCPServerMultiselectDialog(arg0: {
  serverNames: string[]
  configs: Record<string, McpServerConfig | ScopedMcpServerConfig>
  onDone: () => void
}): React.ReactNode {
  return notBuilt('src/components/MCPServerMultiselectDialog.tsx:9')
}

export default MCPServerMultiselectDialog
