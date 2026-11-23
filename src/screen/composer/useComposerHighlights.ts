import { useMemo } from 'react'
import type { Command } from '../../commands/catalogue/commands.js'
import { parseReferences } from '../../sessions/promptHistory.js'
import type { useHistorySearch } from './history-search/useHistorySearch.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { findSlashCommandPositions } from '../suggestions/commandSuggestions.js'
import { findSlackChannelPositions } from '../slack-suggestions/slackChannelSuggestions.js'
import type { TextHighlight } from './textHighlighting.js'
import { findTokenBudgetPositions } from './tokenBudgetMentions.js'

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
}): TextHighlight[] {
  return useMemo(() => {
    const display =
      isSearchingHistory && historySearch.historyMatch
        ? historySearch.historyMatch.display
        : input
    const spans: TextHighlight[] = []

    if (
      isSearchingHistory &&
      !historySearch.historyFailedMatch &&
      historySearch.historyMatch !== undefined &&
      historySearch.historyQuery.length > 0
    ) {
      const end = Math.min(historySearch.historyQuery.length, display.length)
      if (end > 0) {
        spans.push({
          start: 0,
          end,
          color: 'permission',
          priority: 20,
        })
      }
    }

    for (const ref of parseReferences(display)) {
      if (ref.index === cursorOffset) {
        spans.push({
          start: ref.index,
          end: ref.index + ref.match.length,
          inverse: true,
          priority: 8,
        })
      }
    }

    const knownCommands = new Set<string>()
    for (const command of commands) {
      knownCommands.add(command.name)
      if (command.aliases !== undefined) {
        for (const alias of command.aliases) {
          knownCommands.add(alias)
        }
      }
    }
    for (const pos of findSlashCommandPositions(display)) {
      const bareName = display.slice(pos.start + 1, pos.end)
      if (knownCommands.has(bareName)) {
        spans.push({
          start: pos.start,
          end: pos.end,
          color: 'suggestion',
          priority: 5,
        })
      }
    }

    for (const pos of findTokenBudgetPositions(display)) {
      spans.push({
        start: pos.start,
        end: pos.end,
        color: 'suggestion',
        priority: 5,
      })
    }

    if (mcpClients.some(client => client.name.toLowerCase().includes('slack'))) {
      for (const pos of findSlackChannelPositions(display)) {
        spans.push({
          start: pos.start,
          end: pos.end,
          color: 'suggestion',
          priority: 5,
        })
      }
    }

    return spans
  }, [
    isSearchingHistory,
    historySearch.historyMatch,
    historySearch.historyFailedMatch,
    historySearch.historyQuery,
    input,
    cursorOffset,
    commands,
    mcpClients,
  ])
}
