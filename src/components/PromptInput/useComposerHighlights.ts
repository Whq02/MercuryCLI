import { useMemo } from 'react'
import type { Command } from '../../commands.js'
import { parseReferences } from '../../history.js'
import type { useHistorySearch } from '../../hooks/useHistorySearch.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js'
import { findSlackChannelPositions } from '../../services/suggestions/slackChannelSuggestions.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export function useComposerHighlights(arg0: {
  isSearchingHistory: boolean
  historySearch: ReturnType<typeof useHistorySearch>
  input: string
  cursorOffset: number
  commands: Command[]
  mcpClients: MCPServerConnection[]
}): Unbuilt {
  return notBuilt('src/components/PromptInput/useComposerHighlights.ts:11')
}
