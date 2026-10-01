
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
      const kit: { projectOn?: string[]; projectOff?: string[] } = {}
      if (enabled.length > 0) kit.projectOn = unionInto(current.kit?.projectOn, enabled)
      if (disabled.length > 0) kit.projectOff = unionInto(current.kit?.projectOff, disabled)
      if (kit.projectOn || kit.projectOff) updateSettingsForSource('localSettings', { kit })
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
