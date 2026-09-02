// Project MCP-server consent, several servers: a multi-select that
// defaults to everything selected. Submit unions the chosen names into the
// enabled list and the rest into the disabled list (each write only when
// non-empty); escape rejects ALL of them. Local settings scope.

import React, { useCallback } from 'react'
import { Box, Text } from '../ink.js'
import { SelectMulti } from './CustomSelect/index.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

function unionInto(list: string[] | undefined, names: string[]): string[] {
  return [...new Set([...(list ?? []), ...names])]
}

export function MCPServerMultiselectDialog({
  serverNames,
  onDone,
}: {
  serverNames: string[]
  onDone: () => void
}): React.ReactNode {
  const tokens = useMercuryTokens()

  const commit = useCallback(
    (enabled: string[], disabled: string[]) => {
      const current = getSettingsForSource('localSettings') ?? {}
      const updates: {
        enabledMcpjsonServers?: string[]
        disabledMcpjsonServers?: string[]
      } = {}
      if (enabled.length > 0) {
        updates.enabledMcpjsonServers = unionInto(
          current.enabledMcpjsonServers,
          enabled,
        )
      }
      if (disabled.length > 0) {
        updates.disabledMcpjsonServers = unionInto(
          current.disabledMcpjsonServers,
          disabled,
        )
      }
      if (updates.enabledMcpjsonServers || updates.disabledMcpjsonServers) {
        updateSettingsForSource('localSettings', updates)
      }
      onDone()
    },
    [onDone],
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
        {serverNames.length} new MCP servers found in .mcp.json
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
        space to select · enter to confirm · esc to reject all
      </Text>
    </Box>
  )
}

export default MCPServerMultiselectDialog
