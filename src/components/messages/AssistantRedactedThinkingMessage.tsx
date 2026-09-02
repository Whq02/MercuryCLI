import React from 'react'
import { Box } from '../../ink.js'
import { ThinkingLabel } from './thinkingGrammar.js'

type Props = {
  addMargin: boolean
}

// The redacted-thinking transcript stub: reasoning happened and the wire
// withheld it, so the row is the thinking grammar's header with nothing to
// expand — no disclosure cue (a cue here would be a dead toggle) and no body.
// Glyph, word and colour are the grammar's (thinkingGrammar.tsx), the same
// row its sibling AssistantThinkingMessage paints.
export function AssistantRedactedThinkingMessage({
  addMargin = false,
}: Props): React.ReactNode {
  return (
    <Box marginTop={addMargin ? 1 : 0}>
      <ThinkingLabel />
    </Box>
  )
}
