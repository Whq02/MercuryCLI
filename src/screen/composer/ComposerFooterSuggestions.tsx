import React from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import { computeChromeMode } from '../fullscreen-layout/useLayoutTier.js'
import { useSelectedSuggestion } from './suggestionSelectionStore.js'
import { useMercuryTokens } from '../widgets/useMercuryTokens.js'
import { GLYPH, displayWidth, truncateToWidth } from '../theme/glyphs.js'
import { collapseWhitespace } from '../../platform/text/strings.js'
import { truncatePathMiddle } from '../../platform/text/truncate.js'

export type SuggestionType =
  | 'none'
  | 'command'
  | 'file'
  | 'directory'
  | 'slack-channel'
  | 'shell'
  | 'custom-title'
  | 'agent'
  | 'channel-target'
  | 'variable'

import type { SuggestionItem } from './suggestions.js'
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

function StandardRow({
  item,
  columns,
  nameColumn,
  selected,
}: {
  item: SuggestionItem
  columns: number
  nameColumn: number
  selected: boolean
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const nameLimit = Math.max(0, nameColumn - 2)
  const trimmedName =
    displayWidth(item.displayText) > nameLimit
      ? truncateToWidth(item.displayText, nameLimit)
      : item.displayText
  const namePad = Math.max(0, nameColumn - displayWidth(trimmedName))
  const paddedName = trimmedName + ' '.repeat(namePad)

  const collapsedValue = item.value ? collapseWhitespace(item.value) : ''
  const valueText =
    collapsedValue !== '' ? `${truncateToWidth(collapsedValue, 24)}  ` : ''
  const valueWidth = displayWidth(valueText)

  const descriptionBudget = Math.max(
    0,
    columns - nameColumn - valueWidth - 4,
  )
  const collapsedDescription = item.description
    ? collapseWhitespace(item.description)
    : ''
  const descriptionText =
    collapsedDescription !== '' && descriptionBudget > 0
      ? truncateToWidth(collapsedDescription, descriptionBudget)
      : ''

  return (
    <Text
      wrap="truncate-end"
      dimColor={!selected}
      color={selected ? 'suggestion' : item.color}
      backgroundColor={selected ? tokens.selectionBand : undefined}
    >
      {paddedName}
      {valueText !== '' ? <Text color="suggestion">{valueText}</Text> : null}
      {descriptionText !== '' ? <Text dimColor>{descriptionText}</Text> : null}
    </Text>
  )
}

export function PromptInputFooterSuggestions({
  suggestions,
  selectedSuggestion,
  maxColumnWidth,
  overlay = false,
  onPick,
  onHover,
  maxRows,
}: {
  suggestions: SuggestionItem[]
  selectedSuggestion?: number
  maxColumnWidth?: number
  overlay?: boolean
  onPick?: (index: number) => void
  onHover?: (index: number) => void
  maxRows?: number
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const storeSelected = useSelectedSuggestion()

  if (suggestions.length === 0 || maxRows === 0) return null

  const selected =
    selectedSuggestion !== undefined ? selectedSuggestion : storeSelected
  const chromeMode = computeChromeMode(columns, rows)
  const reserve = chromeMode === 'deck-strip' ? 14 : 6
  const baseCapacity = overlay
    ? OVERLAY_MAX_ITEMS
    : Math.max(1, Math.min(6, rows - reserve))
  const capacity =
    maxRows !== undefined ? Math.min(baseCapacity, maxRows) : baseCapacity
  if (capacity <= 0) return null

  const hasOverflow = suggestions.length > capacity && capacity > 1
  const visibleCount = hasOverflow ? capacity - 1 : capacity
  const maxStart = Math.max(0, suggestions.length - visibleCount)
  const anchor = Math.max(0, selected)
  const start = Math.max(
    0,
    Math.min(anchor - Math.floor(visibleCount / 2), maxStart),
  )
  const visibleItems = suggestions.slice(start, start + visibleCount)

  const widestName = suggestions.reduce(
    (max, item) => Math.max(max, displayWidth(item.displayText)),
    0,
  )
  const nameColumn = Math.min(
    Math.floor(columns * 0.4),
    maxColumnWidth ?? widestName + 5,
  )

  const counterIndex = Math.min(Math.max(1, selected + 1), suggestions.length)

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visibleItems.map((item, offset) => {
        const absoluteIndex = start + offset
        const isSelected = absoluteIndex === selected
        const isUnified = unifiedGlyph(item.id) !== null
        return (
          <Box
            key={`${item.id}-${absoluteIndex}`}
            flexDirection="row"
            onClick={onPick ? () => onPick(absoluteIndex) : undefined}
            onMouseEnter={onHover ? () => onHover(absoluteIndex) : undefined}
          >
            <Text color="claude">▏</Text>
            {isUnified ? (
              <UnifiedRow
                item={item}
                columns={columns}
                selected={isSelected}
              />
            ) : (
              <StandardRow
                item={item}
                columns={columns}
                nameColumn={nameColumn}
                selected={isSelected}
              />
            )}
          </Box>
        )
      })}
      {hasOverflow ? (
        <Text dimColor wrap="truncate-end">
          {`  ${counterIndex} of ${suggestions.length}`}
        </Text>
      ) : null}
    </Box>
  )
}

export default React.memo(PromptInputFooterSuggestions)
