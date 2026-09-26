import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { GLYPH, displayWidth } from './glyphs.js'
import { InteractiveRow } from './InteractiveRow.js'

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
  onFocus,
  id,
}: {
  focused: boolean
  text: string
  placeholder: string
  accent: string
  muted: string
  primary: string
  onFocus?: () => void
  id?: string
}): React.ReactNode {
  const line = (
    <Text wrap="truncate-end">
      <Text color={focused ? accent : muted}>/ </Text>
      {text !== '' ? <Text color={primary}>{text}</Text> : <Text color={muted}>{placeholder}</Text>}
    </Text>
  )
  if (onFocus === undefined) return <Box height={1}>{line}</Box>
  return (
    <InteractiveRow id={id ?? 'menu:filter'} height={1} directActivate onActivate={onFocus}>
      {() => line}
    </InteractiveRow>
  )
}
