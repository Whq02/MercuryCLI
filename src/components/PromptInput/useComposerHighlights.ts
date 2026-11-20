import { useMemo } from 'react'
import type { Command } from '../../commands.js'
import { parseReferences } from '../../history.js'
import type { useHistorySearch } from '../../hooks/useHistorySearch.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js'
import { findSlackChannelPositions } from '../../services/suggestions/slackChannelSuggestions.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js'

export function useComposerHighlights({
  isSearchingHistory,
  historySearch,
  input,
  cursorOffset,
  commands,
  mcpClients,
}: {
  isSearchingHistory: boolean
  historySearch: ReturnType<typeof useHistorySearch>
  input: string
  cursorOffset: number
  commands: Command[]
  mcpClients: MCPServerConnection[]
}) {
  const displayedValue = isSearchingHistory
    ? (historySearch.historyMatch?.display ?? input)
    : input
  const highlights = useMemo((): TextHighlight[] => {
    const spans: TextHighlight[] = []
    if (isSearchingHistory && historySearch.historyMatch !== undefined && !historySearch.historyFailedMatch) {
      spans.push({
        start: 0,
        end: Math.min(historySearch.historyQuery.length, displayedValue.length),
        color: 'permission',
        priority: 20,
      })
    }
    for (const ref of parseReferences(displayedValue)) {
      if (ref.index === cursorOffset) {
        spans.push({
          start: ref.index,
          end: ref.index + ref.match.length,
          inverse: true,
          priority: 8,
        })
      }
    }
    for (const position of findSlashCommandPositions(displayedValue)) {
      const bare = displayedValue.slice(position.start + 1, position.end)
      if (commands.some(command => command.name === bare || command.aliases?.includes(bare) === true)) {
        spans.push({ start: position.start, end: position.end, color: 'suggestion', priority: 5 })
      }
    }
    for (const position of findTokenBudgetPositions(displayedValue)) {
      spans.push({ start: position.start, end: position.end, color: 'suggestion', priority: 5 })
    }
    if (mcpClients.some(client => client.name.toLowerCase().includes('slack'))) {
      for (const position of findSlackChannelPositions(displayedValue)) {
        spans.push({ start: position.start, end: position.end, color: 'suggestion', priority: 5 })
      }
    }
    return spans
  }, [displayedValue, isSearchingHistory, historySearch.historyMatch, historySearch.historyFailedMatch, historySearch.historyQuery, cursorOffset, commands, mcpClients])
  return highlights
}
