
import React from 'react'
import { Box, Text } from '../../ink.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { TEAMMATE_COLOR_ENV_VAR } from '../../utils/swarm/constants.js'
import type { Theme } from '../../utils/theme.js'
import { ReadyBreath } from '../mercury-ui/LiveGlyphs.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
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
}: {
  mode: PromptInputMode
  isLoading: boolean
  inputEmpty: boolean
  viewedAgentName?: string
  viewedAgentColor?: string
}): React.ReactNode {
  const accent = useSessionAccent()

  if (viewedAgentName !== undefined && viewedAgentName !== '') {
    const color = validatedThemeColor(viewedAgentColor) ?? 'suggestion'
    return (
      <Box flexShrink={0}>
        <Text color={color} dimColor={isLoading}>
          {POINTER}{' '}
        </Text>
      </Box>
    )
  }

  if (mode === 'bash') {
    return (
      <Box flexShrink={0}>
        <Text color="bashBorder" dimColor={isLoading}>
          {BASH_MODE_CHARACTER}{' '}
        </Text>
      </Box>
    )
  }

  const envTeammateColor = isAgentSwarmsEnabled()
    ? validatedThemeColor(process.env[TEAMMATE_COLOR_ENV_VAR])
    : undefined
  if (envTeammateColor !== undefined) {
    return (
      <Box flexShrink={0}>
        <Text color={envTeammateColor} dimColor={isLoading}>
          {POINTER}{' '}
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
        {POINTER}{' '}
      </ReadyBreath>
    </Box>
  )
}
