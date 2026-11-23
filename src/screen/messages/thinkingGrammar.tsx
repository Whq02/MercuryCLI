
import React from 'react'
import { Text } from '../themedRenderer.js'
import type { Theme } from '../theme/theme.js'
import { TEARDROP_ASTERISK } from '../theme/rowGlyphs.js'

export const THINKING_GLYPH = TEARDROP_ASTERISK
export const THINKING_WORD = 'thinking'
export const THINKING_LABEL = `${THINKING_GLYPH} ${THINKING_WORD}…`
export const THINKING_COLOR: keyof Theme = 'subtle'

export const WITHHELD_THINKING_WORDS = 'the provider returned no thinking text for this model'

export function ThinkingLabel({
  children,
}: {
  children?: React.ReactNode
}): React.ReactNode {
  return (
    <Text italic color={THINKING_COLOR}>
      {THINKING_LABEL}
      {children}
    </Text>
  )
}
