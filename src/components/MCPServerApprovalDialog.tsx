import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../utils/mcp/types.js'
import { recordProjectMcpServerChoices } from '../services/mcp/utils.js'
import { notBuilt } from '../pi/holes.js'

export function MCPServerApprovalDialog(arg0: {
  serverName: string
  config: McpServerConfig | ScopedMcpServerConfig
  onDone: () => void
}): React.ReactNode {
  return notBuilt('src/components/MCPServerApprovalDialog.tsx:9')
}

export default MCPServerApprovalDialog
