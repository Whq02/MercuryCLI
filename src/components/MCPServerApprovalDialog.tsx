// Project MCP-server consent, single server: a new server found in
// the project's .mcp.json. Three choices; all writes go to the LOCAL
// settings scope and adds are idempotent. Escape declines.

import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { Select } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

function addTo(list: string[] | undefined, name: string): string[] {
  const existing = list ?? []
  return existing.includes(name) ? existing : [...existing, name]
}

export function MCPServerApprovalDialog({
  serverName,
  onDone,
}: {
  serverName: string
  onDone: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()

  const choose = useCallback(
    (choice: 'enable-all' | 'enable' | 'disable') => {
      const current = getSettingsForSource('localSettings') ?? {}
      if (choice === 'disable') {
        updateSettingsForSource('localSettings', {
          disabledMcpjsonServers: addTo(
            current.disabledMcpjsonServers,
            serverName,
          ),
        })
      } else {
        updateSettingsForSource('localSettings', {
          enabledMcpjsonServers: addTo(
            current.enabledMcpjsonServers,
            serverName,
          ),
          ...(choice === 'enable-all'
            ? { enableAllProjectMcpServers: true }
            : {}),
        })
      }
      onDone()
    },
    [serverName, onDone],
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
        New MCP server found in .mcp.json: <Text color={tokens.info}>{serverName}</Text>
      </Text>
      <Text>MCP servers may execute code or access external systems.</Text>
      <Select
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
    </Box>
  )
}

export default MCPServerApprovalDialog
