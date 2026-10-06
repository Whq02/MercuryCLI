import React from 'react'
import { Text } from '../../ink.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { TOOL_FAMILY_MARKS, type ToolFamily } from '../mercury-ui/toolGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'

export type ToolRowState = 'pending' | 'done' | 'error' | 'denied'

export function toolRowStateOf(flags: { resolved: boolean; errored: boolean; denied: boolean }): ToolRowState {
  if (flags.denied) return 'denied'
  if (flags.errored) return 'error'
  return flags.resolved ? 'done' : 'pending'
}

export function ToolRowLead({ family, state }: { family: ToolFamily; state: ToolRowState }): React.ReactNode {
  const tokens = useMercuryTokens()
  const mark = TOOL_FAMILY_MARKS[family]
  if (state === 'denied') return <Text color={tokens.failure}>{GLYPH.fail} </Text>
  if (state === 'error') return <Text color={tokens.failure}>{mark.glyph} </Text>
  if (state === 'pending') return <Text dimColor>{mark.glyph} </Text>
  return <Text color={tokens[mark.tone]}>{mark.glyph} </Text>
}
