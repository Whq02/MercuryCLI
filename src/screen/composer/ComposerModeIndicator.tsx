
import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import type { InputMode } from './input-core/textInput.js'
import { ReadyBreath } from '../widgets/LiveGlyphs.js'
import { useSessionAccent } from '../widgets/sessionAccent.js'
import { BASH_MODE_CHARACTER } from './inputModes.js'

const POINTER = '❯'

export function ComposerModeIndicator({
  mode,
  isLoading,
  inputEmpty,
  viewedAgentName,
  cells = 2,
}: {
  mode: InputMode
  isLoading: boolean
  inputEmpty: boolean
  viewedAgentName?: string
  cells?: number
}): React.ReactNode {
  const accent = useSessionAccent()
  if (cells === 0) return null
  const space = cells > 1 ? ' ' : ''

  if (viewedAgentName !== undefined && viewedAgentName !== '') {
    return (
      <Box flexShrink={0}>
        <Text color="suggestion" dimColor={isLoading}>
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
