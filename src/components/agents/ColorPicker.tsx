// The agent colour chooser: `automatic` plus the palette roster, with a
// live name-chip preview on the chosen colour. Keys are handled by the
// container's own key handler; the surface takes keyboard focus on mount.

import figures from 'figures'
import React, { useState } from 'react'
import { Box, Text } from '../../ink.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import {
  AGENT_COLORS,
  AGENT_COLOR_TO_THEME_COLOR,
  type AgentColorName,
} from '../../tools/AgentTool/agentColorManager.js'
import { capitalize } from '../../utils/stringUtils.js'

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
  const [selected, setSelected] = useState(() => {
    const at = currentColor ? options.indexOf(currentColor) : 0
    return at === -1 ? 0 : at
  })

  const chosen = options[selected]
  const chosenRole =
    chosen !== undefined && chosen !== AUTOMATIC
      ? AGENT_COLOR_TO_THEME_COLOR[chosen as AgentColorName]
      : 'suggestion'

  return (
    <Box
      flexDirection="column"
      tabIndex={-1}
      autoFocus
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === 'up') {
          setSelected(current => (current - 1 + options.length) % options.length)
          event.stopImmediatePropagation()
        } else if (event.key === 'down') {
          setSelected(current => (current + 1) % options.length)
          event.stopImmediatePropagation()
        } else if (event.key === 'return') {
          const value = options[selected]
          onConfirm(
            value === AUTOMATIC ? undefined : (value as AgentColorName),
          )
          event.stopImmediatePropagation()
        }
      }}
    >
      {options.map((option, index) => {
        const isSelected = index === selected
        return (
          <Box key={option} gap={1}>
            <Text color="suggestion">{isSelected ? figures.pointer : ' '}</Text>
            {option === AUTOMATIC ? (
              <Text bold>automatic</Text>
            ) : (
              <>
                <Text
                  backgroundColor={
                    AGENT_COLOR_TO_THEME_COLOR[option as AgentColorName]
                  }
                  color="inverseText"
                >
                  {' '}
                </Text>
                <Text>{capitalize(option)}</Text>
              </>
            )}
          </Box>
        )
      })}
      <Box marginTop={1} gap={1}>
        <Text>Preview:</Text>
        <Text bold backgroundColor={chosenRole} color="inverseText">
          @{agentName}
        </Text>
      </Box>
    </Box>
  )
}

export default ColorPicker
