import React from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { computeChromeMode } from '../../hooks/useLayoutTier.js'
import { useSelectedSuggestion } from './suggestionSelectionStore.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { GLYPH, displayWidth, truncateToWidth } from '../../utils/glyphs.js'
import { collapseWhitespace } from '../../utils/stringUtils.js'
import { truncatePathMiddle } from '../../utils/truncate.js'

export type SuggestionType =
  Unbuilt

import type { SuggestionItem } from '../../types/suggestions.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'
export type { SuggestionItem }

const OVERLAY_MAX_ITEMS = 5

const UNIFIED_GLYPHS: Array<[string, string]> = [
  ['file-', GLYPH.read],
  ['mcp-resource-', GLYPH.cloud],
  ['agent-', GLYPH.spark],
]

function unifiedGlyph(id: string): string | null {
  for (const [prefix, glyph] of UNIFIED_GLYPHS) {
    if (id.startsWith(prefix)) return glyph
  }
  return null
}

function UnifiedRow({
  item,
  columns,
  selected,
}: {
  item: SuggestionItem
  columns: number
  selected: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const glyph = unifiedGlyph(item.id) ?? GLYPH.read
  const separator = 3
  const descriptionReserve = item.description ? 20 : 0
  let display = item.displayText
  if (item.id.startsWith('file-')) {
    display = truncatePathMiddle(
      display,
      Math.max(8, columns - 2 - 4 - separator - descriptionReserve),
    )
  } else if (item.id.startsWith('mcp-resource-')) {
    display = truncateToWidth(display, 30)
  }
  const descriptionBudget = Math.max(
    0,
    columns - 2 - displayWidth(display) - separator - 4,
  )
  const description = item.description
    ? truncateToWidth(collapseWhitespace(item.description), descriptionBudget)
    : ''
  return (
    <Text
      wrap="truncate-end"
      dimColor={!selected}
      color={selected ? 'suggestion' : undefined}
      backgroundColor={selected ? tokens.selectionBand : undefined}
    >
      {glyph} {display}
      {description !== '' ? <Text dimColor> – {description}</Text> : null}
    </Text>
  )
}

export function PromptInputFooterSuggestions(arg0: {
  suggestions: SuggestionItem[]
  selectedSuggestion?: number
  maxColumnWidth?: number
  overlay?: boolean
  onPick?: (index: number) => void
  onHover?: (index: number) => void
  maxRows?: number
}): React.ReactNode {
  return notBuilt('src/components/PromptInput/PromptInputFooterSuggestions.tsx:123')
}

export default React.memo(PromptInputFooterSuggestions)
