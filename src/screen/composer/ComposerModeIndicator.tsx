
import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { PromptInputMode } from './input-core/textInput.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/crewmate/crewmateColors.js'
import type { Theme } from '../theme/theme.js'
import { ReadyBreath } from '../widgets/LiveGlyphs.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { BASH_MODE_CHARACTER } from './inputModes.js'

const POINTER = '❯'

function validatedThemeColor(raw: string | undefined): keyof Theme | undefined {
  if (raw === undefined) return undefined
  return (AGENT_COLOR_TO_THEME_COLOR as Record<string, keyof Theme>)[raw]
}

export function PromptInputModeIndicator({
  mode,
  isLoading,
  inputEmpty,
  viewedAgentName,
  viewedAgentColor,
  cells = 2,
}: {
  mode: PromptInputMode
  isLoading: boolean
  inputEmpty: boolean
  viewedAgentName?: string
  viewedAgentColor?: string
  cells?: number
}): React.ReactNode {
  const accent = useSessionAccent()
  if (cells === 0) return null
  const space = cells > 1 ? ' ' : ''

  if (viewedAgentName !== undefined && viewedAgentName !== '') {
    const color = validatedThemeColor(viewedAgentColor) ?? 'suggestion'
    return (
      <Box flexShrink={0}>
        <Text color={color} dimColor={isLoading}>
          {POINTER}{space}
        </Text>
      </Box>
    )
  }

  if (mode === 'bash') {
    return (
      <Box flexShrink={0}>
        <Text color="bashBorder" dimColor={isLoading}>
          {BASH_MODE_CHARACTER}{space}
        </Text>
      </Box>
    )
  }

  const breathing = !isLoading && inputEmpty
  return (
    <Box flexShrink={0}>
      <ReadyBreath
        deep={accent.accentDeep}
        to={accent.accent}
        active={breathing}
        dim={isLoading}
      >
        {POINTER}{space}
      </ReadyBreath>
    </Box>
  )
}
