import type React from 'react'
import type { Command } from '../../commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import { swarmView } from '../../services/crewBoard/seam.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../services/engine-connector/focusedConnector.js'
import type { AppStateStore } from '../../state/AppStateStore.js'
import type { InlineGhostText, PromptInputMode } from '../../types/textInputTypes.js'
import {
  generateProgressiveArgumentHint,
  parseArgumentNames,
  parseArguments,
} from '../../utils/argumentSubstitution.js'
import { formatLogMetadata } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { searchSessionsByCustomTitle } from '../../utils/sessionStorage.js'
import {
  channelTargetCandidates,
  findChannelTargetQuery,
  findMidInputSlashCommand,
  generateCommandSuggestions,
  getBestCommandMatch,
  hasCommandArgs,
  rankChannelTargets,
} from '../../utils/suggestions/commandSuggestions.js'
import {
  getPathCompletions,
  isPathLikeToken,
} from '../../utils/suggestions/directoryCompletion.js'
import { getShellHistoryCompletion } from '../../utils/suggestions/shellHistoryCompletion.js'
import {
  getSlackChannelSuggestions,
  hasSlackMcpServer,
} from '../../services/suggestions/slackChannelSuggestions.js'
import type { Publish, SuggestionsState } from './state.js'
import { armTypeaheadTimer } from './timers.js'
import { extractCompletionToken, extractSearchToken, shellMetadataOf } from './tokens.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

const CHANNEL_FETCH_DEBOUNCE_MS = 150
const RESUME_TITLE_LIMIT = 10

export type LadderContext = Unbuilt

export function ladderChannelTarget(arg0: LadderContext): boolean {
  return notBuilt('src/hooks/typeahead/ladder.ts:72')
}

export function ladderMentions(arg0: LadderContext): boolean {
  return notBuilt('src/hooks/typeahead/ladder.ts:94')
}

export function ladderCommands(arg0: LadderContext): boolean {
  return notBuilt('src/hooks/typeahead/ladder.ts:171')
}

export function ladderClearStale({ input, cursor, argumentHint, clearSuggestions, cancelFileFetch, setSuggestionsState, suggestionsRef, suggestionTypeRef }: LadderContext): void {
  if (suggestionTypeRef.current === 'command' && !input.startsWith('/')) {
    cancelFileFetch()
    clearSuggestions()
  }
  if (hasCommandArgs(input) && argumentHint) {
    setSuggestionsState(prev => ({
      suggestions: prev.suggestions,
      selectedSuggestion: prev.selectedSuggestion,
    }))
  }
  if (suggestionTypeRef.current === 'custom-title') {
    clearSuggestions()
  }
  if (
    suggestionTypeRef.current === 'agent' &&
    suggestionsRef.current.some(item => item.id.startsWith('dm-')) &&
    !/(^|\s)@[\w-]*$/.test(input.slice(0, cursor))
  ) {
    clearSuggestions()
  }
}

export function ladderPaths(arg0: LadderContext): void {
  return notBuilt('src/hooks/typeahead/ladder.ts:273')
}

function describeAgent(
  state: ReturnType<AppStateStore['getState']>,
  name: string,
): string {
  const taskId = state.agentNameRegistry.get(name)
  if (taskId) {
    const task = state.tasks[taskId]
    if (task?.status) return `send a message · ${task.status}`
  }
  return 'send a message'
}
