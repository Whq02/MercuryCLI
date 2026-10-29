import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../services/mcp/types.js'
import { recordProjectMcpServerChoices } from '../services/mcp/utils.js'

export function MCPServerApprovalDialog({
  serverName,
  config,
  onDone,
}: {
  serverName: string
  config: McpServerConfig | ScopedMcpServerConfig
  onDone: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()

  const choose = useCallback(
    (choice: 'enable-all' | 'enable' | 'disable') => {
      if (choice === 'disable') {
        recordProjectMcpServerChoices({ rejected: [serverName] })
      } else {
        recordProjectMcpServerChoices({
          approved: [{ name: serverName, config }],
          ...(choice === 'enable-all' ? { trustAll: true } : {}),
        })
      }
      onDone()
    },
    [serverName, config, onDone],
  )

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tokens.warning}
      paddingX={1}
      gap={1}
    >
      <Text bold>
        New MCP server found in this project's .mercury/mcp.json: <Text color={tokens.info}>{serverName}</Text>
      </Text>
      <Text>MCP servers may execute code or access external systems.</Text>
      <Select
        defaultFocusValue="enable"
        options={[
          {
            label: 'Use this and all future MCP servers in this project',
            value: 'enable-all',
          },
          { label: 'Use this MCP server', value: 'enable' },
          { label: 'Continue without this MCP server', value: 'disable' },
        ]}
        onChange={value =>
          choose(value as 'enable-all' | 'enable' | 'disable')
        }
        onCancel={() => choose('disable')}
      />
      <Text dimColor>↑↓ move · ↵ confirm · esc reject</Text>
    </Box>
  )
}

export default MCPServerApprovalDialog
