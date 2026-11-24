import React, { useState } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { useModalOrTerminalSize } from '../overlays/modalContext.js'
import { Select } from '../select/Select.js'
import {
  AGENT_COLORS,
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '../../tools/crewmate/crewmateColors.js'
import { capitalize } from '../../platform/text/strings.js'

const AUTOMATIC = 'automatic'

export function ColorPicker({
  agentName,
  currentColor,
  onConfirm,
}: {
  agentName: string
  currentColor?: AgentColorName
  onConfirm: (color: AgentColorName | undefined) => void
}): React.ReactNode {
  const options: readonly string[] = [AUTOMATIC, ...AGENT_COLORS]
  const [chosen, setChosen] = useState<string>(currentColor ?? AUTOMATIC)
  const terminal = useTerminalSize()
  const { rows } = useModalOrTerminalSize(terminal)
  const chosenRole = chosen !== AUTOMATIC
    ? AGENT_COLOR_TO_THEME_COLOR[chosen as AgentColorName]
    : 'suggestion'

  return (
    <Box flexDirection="column">
      <Select
        hideIndexes
        visibleOptionCount={Math.max(1, Math.min(options.length, rows - 6))}
        defaultFocusValue={currentColor ?? AUTOMATIC}
        onFocus={setChosen}
        onChange={value => onConfirm(value === AUTOMATIC ? undefined : value as AgentColorName)}
        options={options.map(option => ({
          value: option,
          label: option === AUTOMATIC ? <Text bold>automatic</Text> : <Text><Text backgroundColor={AGENT_COLOR_TO_THEME_COLOR[option as AgentColorName]} color="inverseText"> </Text> {capitalize(option)}</Text>,
        }))}
      />
      <Box marginTop={1} gap={1}>
        <Text>Preview:</Text>
        <Text bold backgroundColor={chosenRole} color="inverseText">@{agentName}</Text>
      </Box>
      <Text dimColor>↑↓ move · pgup/pgdn page · ↵ confirm · esc back</Text>
    </Box>
  )
}
