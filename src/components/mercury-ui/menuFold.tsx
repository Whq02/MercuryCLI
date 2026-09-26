import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { GLYPH, displayWidth } from './glyphs.js'

export const FOLD_OPEN_LEAD = '▾ '
export const FOLD_CLOSED_LEAD = '▸ '

export function foldLead(opts: { selected: boolean; folder: boolean; open: boolean }): string {
  if (opts.selected) return `${GLYPH.prompt} `
  if (opts.folder) return opts.open ? FOLD_OPEN_LEAD : FOLD_CLOSED_LEAD
  return '  '
}

export function cutToWidth(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = displayWidth(ch)
    if (used + w > width) break
    out += ch
    used += w
  }
  return out
}

export function MenuFilterLine({
  focused,
  text,
  placeholder,
  accent,
  muted,
  primary,
}: {
  focused: boolean
  text: string
  placeholder: string
  accent: string
  muted: string
  primary: string
}): React.ReactNode {
  return (
    <Box height={1}>
      <Text wrap="truncate-end">
        <Text color={focused ? accent : muted}>/ </Text>
        {text !== '' ? <Text color={primary}>{text}</Text> : <Text color={muted}>{placeholder}</Text>}
      </Text>
    </Box>
  )
}
