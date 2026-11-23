import React from 'react'
import { Box } from '../themedRenderer.js'
import { ThinkingLabel } from './thinkingGrammar.js'

type Props = {
  addMargin: boolean
}

export function AssistantRedactedThinkingMessage({
  addMargin = false,
}: Props): React.ReactNode {
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <ThinkingLabel />
    </Box>
  )
}
