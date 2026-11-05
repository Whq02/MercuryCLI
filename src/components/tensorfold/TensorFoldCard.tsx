import * as React from 'react'
import { Text } from '../../ink.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from '../mercuryPalette.js'
import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'
import type { TensorFoldCardLine, TensorFoldTone } from './tensorfoldRows.js'

export function tensorFoldInk(tone: TensorFoldTone, tokens: MercuryThemeTokens, accent: string): string {
  switch (tone) {
    case 'faint':
      return FAINT
    case 'ivory':
      return IVORY
    case 'teal':
      return TEAL
    case 'amber':
      return AMBER
    case 'sand':
      return SAND
    case 'info':
      return tokens.info
    case 'failure':
      return tokens.failureText
    case 'secondary':
      return tokens.textSecondary
    case 'accent':
      return accent
  }
}

export function TensorFoldCard({ lines, tokens, accent }: { lines: readonly TensorFoldCardLine[]; tokens: MercuryThemeTokens; accent: string }): React.ReactNode {
  return lines.map((line, at) => (
    <Text key={at} wrap="truncate-end">
      {line.map((seg, k) => (
        <Text key={k} color={tensorFoldInk(seg.tone, tokens, accent)} bold={seg.bold === true}>
          {seg.text}
        </Text>
      ))}
    </Text>
  ))
}
