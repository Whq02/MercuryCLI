import React from 'react'
import { Text } from '../themedRenderer.js'
import { GLYPH } from '../theme/glyphs.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'

type ToolRowState = 'pending' | 'done' | 'error' | 'denied'

export function toolRowStateOf(flags: { resolved: boolean; errored: boolean; denied: boolean }): ToolRowState {
  if (flags.denied) return 'denied'
  if (flags.errored) return 'error'
  return flags.resolved ? 'done' : 'pending'
}

export function ToolRowLead({ state }: { state: ToolRowState }): React.ReactNode {
  const tokens = useMercuryTokens()
  if (state === 'denied' || state === 'error') {
    return <Text color={tokens.failure}>{GLYPH.fail} </Text>
  }
  return null
}
