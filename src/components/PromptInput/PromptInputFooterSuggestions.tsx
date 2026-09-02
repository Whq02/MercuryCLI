
import React from 'react'
import { Box, Text } from '../../ink.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { computeChromeMode } from '../../hooks/useLayoutTier.js'
import { useSelectedSuggestion } from './suggestionSelectionStore.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { GLYPH, displayWidth, truncateToWidth } from '../mercury-ui/glyphs.js'
import { truncatePathMiddle } from '../../utils/truncate.js'

export type SuggestionType =
  | 'none'
  | 'command'
  | 'file'
  | 'directory'
  | 'slack-channel'
  | 'shell'
  | 'custom-title'
  | 'agent'
  | 'variable'

export type SuggestionItem = {
  id: string
  displayText: string
  tag?: string
  value?: string
  description?: string
  metadata?: unknown
  color?: string
}

export const OVERLAY_MAX_ITEMS = 5

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

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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

function OtherRow({
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
  let name = item.displayText
  if (displayWidth(name) > nameColumn - 2) {
    name = truncateToWidth(name, nameColumn - 2)
  }
  const padded = name + ' '.repeat(Math.max(0, nameColumn - displayWidth(name)))
  const tag = item.tag ? `[${item.tag}] ` : ''
  const value = item.value ? `${truncateToWidth(collapseWhitespace(item.value), 24)}  ` : ''
  const descriptionBudget = Math.max(
    0,
    columns - nameColumn - displayWidth(tag) - displayWidth(value) - 4,
  )
  const description = item.description
    ? truncateToWidth(collapseWhitespace(item.description), descriptionBudget)
    : ''
  return (
    <Text
      wrap="truncate-end"
      dimColor={!selected}
      color={selected ? 'suggestion' : item.color}
      backgroundColor={selected ? tokens.selectionBand : undefined}
    >
      {padded}
      {tag !== '' ? <Text>{tag}</Text> : null}
      {value !== '' ? <Text color={selected ? undefined : 'suggestion'}>{value}</Text> : null}
      {description !== '' ? <Text dimColor>{description}</Text> : null}
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
}: {
  suggestions: SuggestionItem[]
  selectedSuggestion?: number
  maxColumnWidth?: number
  overlay?: boolean
  onPick?: (index: number) => void
  onHover?: (index: number) => void
}): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const storeSelection = useSelectedSuggestion()
  const selected = selectedSuggestion ?? storeSelection

  if (suggestions.length === 0) return null

  const chrome = computeChromeMode(columns, rows)
  const reserve = chrome === 'deck-strip' ? 14 : 6
  let maxVisible = overlay
    ? OVERLAY_MAX_ITEMS
    : Math.min(6, Math.max(1, rows - reserve))
  const overflowing = suggestions.length > maxVisible
  if (overflowing) {
    maxVisible = Math.max(1, maxVisible - 1)
  }

  const anchor = selected >= 0 ? selected : 0
  const half = Math.floor(maxVisible / 2)
  const start = Math.max(
    0,
    Math.min(anchor - half, suggestions.length - maxVisible),
  )
  const visible = suggestions.slice(start, start + maxVisible)

  const isUnified = (item: SuggestionItem): boolean => unifiedGlyph(item.id) !== null

  const derivedWidth =
    Math.max(0, ...suggestions.map(item => displayWidth(item.displayText))) + 5
  const nameColumn = Math.min(
    maxColumnWidth ?? derivedWidth,
    Math.floor(columns * 0.4),
  )

  return (
    <Box flexDirection="column" paddingLeft={1}>
      {visible.map((item, offset) => {
        const absolute = start + offset
        const isSelected = absolute === selected
        const row = isUnified(item) ? (
          <UnifiedRow item={item} columns={columns} selected={isSelected} />
        ) : (
          <OtherRow
            item={item}
            columns={columns}
            nameColumn={nameColumn}
            selected={isSelected}
          />
        )
        return (
          <Box
            key={item.id}
            {...(onPick ? { onClick: () => onPick(absolute) } : {})}
            {...(onHover ? { onMouseEnter: () => onHover(absolute) } : {})}
          >
            <Text color="claude">▏</Text>
            {row}
          </Box>
        )
      })}
      {overflowing ? (
        <Text dimColor>
          {'  '}
          {Math.min(selected + 1, suggestions.length) || 1} of{' '}
          {suggestions.length}
        </Text>
      ) : null}
    </Box>
  )
}

export default React.memo(PromptInputFooterSuggestions)
