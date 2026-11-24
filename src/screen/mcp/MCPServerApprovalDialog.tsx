import React, { useCallback } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { Select } from '../select/index.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { recordProjectMcpServerChoices } from '../../integrations/mcp/utils.js'

type ApprovalChoice = 'enable-all' | 'enable' | 'disable'

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

  const handleSelect = useCallback(
    (choice: ApprovalChoice) => {
      if (choice === 'enable-all') {
        recordProjectMcpServerChoices({
          approved: [{ name: serverName, config }],
          trustAll: true,
        })
      } else if (choice === 'enable') {
        recordProjectMcpServerChoices({
          approved: [{ name: serverName, config }],
        })
      } else {
        recordProjectMcpServerChoices({
          rejected: [serverName],
        })
      }
      onDone()
    },
    [serverName, config, onDone],
  )

  const handleCancel = useCallback(() => {
    handleSelect('disable')
  }, [handleSelect])

  return (
    <Box
      flexDirection="column"
      gap={1}
      paddingX={1}
      borderStyle="round"
      borderColor={tokens.warning}
    >
      <Text bold>
        {"New MCP server found in this project's .mercury/mcp.json: "}
        <Text color={tokens.info}>{serverName}</Text>
      </Text>
      <Text>MCP servers may execute code or access external systems.</Text>
      <Select<ApprovalChoice>
        defaultFocusValue="enable"
        scrollMovesFocus={false}
        options={[
          {
            label: 'Use this and all future MCP servers in this project',
            value: 'enable-all',
          },
          {
            label: 'Use this MCP server',
            value: 'enable',
          },
          {
            label: 'Continue without this MCP server',
            value: 'disable',
          },
        ]}
        onChange={handleSelect}
        onCancel={handleCancel}
      />
      <Text dimColor>↑↓ move · ↵ confirm · esc reject</Text>
    </Box>
  )
}
