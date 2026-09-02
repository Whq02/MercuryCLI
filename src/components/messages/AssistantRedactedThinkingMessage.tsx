import React from 'react'
import { Box, Text } from '../../ink.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { TEARDROP_ASTERISK } from '../../constants/figures.js'

type Props = {
  addMargin: boolean
}

export function AssistantRedactedThinkingMessage({
  addMargin = false,
}: Props): React.ReactNode {
  const accent = useSessionAccent().accent
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <Text color={accent} dimColor={false} italic>
        {TEARDROP_ASTERISK} Thinking…
      </Text>
    </Box>
  )
}
