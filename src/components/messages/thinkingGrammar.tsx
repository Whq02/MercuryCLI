
import React from 'react'
import { Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

export const THINKING_GLYPH = '✳\uFE0E'
export const THINKING_WORD = 'thinking'
export const THINKING_LABEL = `${THINKING_GLYPH} ${THINKING_WORD}…`
export const THINKING_COLOR: keyof Theme = 'subtle'

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
