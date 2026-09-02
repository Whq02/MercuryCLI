// The composer mode glyph. Viewing an agent outranks bash mode;
// bash renders its mode character in the bash colour; prompt mode renders
// the pointer tinted by the environment teammate colour when swarms are on,
// else by the LIVE session accent (read through a subscription so an accent
// change re-tints on the next render). Both forms dim while a turn runs.
// The breathing treatment applies only to the untinted pointer while the
// turn is idle and the buffer is empty — a cell in motion must not sit next
// to text the operator is composing.

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
  /** Defined while viewing an agent — outranks bash mode. */
  viewedAgentName?: string
  viewedAgentColor?: string
}): React.ReactNode {
  const accent = useSessionAccent()

  // The glyph never wraps and hugs the start of its row.
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

  // The untinted pointer: accent-tinted, breathing only while genuinely
  // ready-and-idle (ReadyBreath itself degrades for reduced motion and the
  // live-glyph opt-out). Running or a typed character stills it immediately.
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
