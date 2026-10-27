
import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { SelectMulti } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import type { McpServerConfig, ScopedMcpServerConfig } from '../services/mcp/types.js'
import { recordProjectMcpServerChoices } from '../services/mcp/utils.js'

export function MCPServerMultiselectDialog({
  serverNames,
  configs,
  onDone,
}: {
  serverNames: string[]
  configs: Record<string, McpServerConfig | ScopedMcpServerConfig>
  onDone: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()

  const commit = useCallback(
    (enabled: string[], disabled: string[]) => {
      recordProjectMcpServerChoices({
        approved: enabled.flatMap(name => (configs[name] === undefined ? [] : [{ name, config: configs[name] as McpServerConfig }])),
        rejected: disabled,
      })
      onDone()
    },
    [configs, onDone],
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
        {serverNames.length} new MCP servers found in this project's .mercury/mcp.json
      </Text>
      <Text>
        Select the servers you want to use in this project. MCP servers may
        execute code or access external systems.
      </Text>
      <SelectMulti
        options={serverNames.map(name => ({ label: name, value: name }))}
        defaultValue={serverNames}
        onSubmit={selected => {
          const chosen = new Set(selected)
          commit(
            serverNames.filter(name => chosen.has(name)),
            serverNames.filter(name => !chosen.has(name)),
          )
        }}
        onCancel={() => commit([], serverNames)}
      />
      <Text dimColor>
        ↑↓ move · pgup/pgdn page · space select · ↵ confirm · esc reject all
      </Text>
    </Box>
  )
}

export default MCPServerMultiselectDialog
