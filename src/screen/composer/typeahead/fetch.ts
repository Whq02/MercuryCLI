import type React from 'react'
import type { Command } from '../../../commands/catalogue/commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../ComposerFooterSuggestions.js'
import { getSelectedSuggestion } from '../suggestionSelectionStore.js'
import type { AppStateStore } from '../../app-state/AppStateStore.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import type { InlineGhostText, PromptInputMode } from '../input-core/textInput.js'
import { logError } from '../../../platform/logs/errorLog.js'
import {
  findMidInputSlashCommand,
  getBestCommandMatch,
} from '../../suggestions/commandSuggestions.js'
import {
  getPathCompletions,
  isPathLikeToken,
} from '../../suggestions/pathCompletion.js'
import { generateUnifiedSuggestions } from './unifiedSuggestions.js'
import type { Publish, SuggestionsState } from './state.js'
import { armTypeaheadTimer } from './timers.js'
import { extractCompletionToken, extractSearchToken, preservedSelection } from './tokens.js'

const FILE_FETCH_DEBOUNCE_MS = 50

export function publishSuggestionsOf(
  next: Suggestion[],
  type: SuggestionType,
  opts: { selected?: number; maxWidth?: number; argumentHint?: string } | undefined,
  {
    setSuggestionType,
    setMaxColumnWidth,
    setSuggestionsState,
    userNavigatedRef,
    suggestionsRef,
  }: {
    setSuggestionType: React.Dispatch<React.SetStateAction<SuggestionType>>
    setMaxColumnWidth: React.Dispatch<React.SetStateAction<number | undefined>>
    setSuggestionsState: (
      update: SuggestionsState | ((prev: SuggestionsState) => SuggestionsState),
    ) => void
    userNavigatedRef: React.MutableRefObject<boolean>
    suggestionsRef: React.MutableRefObject<Suggestion[]>
  },
): void {
  setSuggestionType(type)
  if (opts?.maxWidth !== undefined) setMaxColumnWidth(opts.maxWidth)
  userNavigatedRef.current = false
  const selected =
    opts?.selected ??
    preservedSelection(next, suggestionsRef.current, getSelectedSuggestion())
  setSuggestionsState(prev => ({
    suggestions: next,
    selectedSuggestion: selected,
    ...(opts?.argumentHint !== undefined
      ? { commandArgumentHint: opts.argumentHint }
      : opts?.selected === -1
        ? {}
        : prev.commandArgumentHint !== undefined
          ? { commandArgumentHint: prev.commandArgumentHint }
          : {}),
  }))
}

export function runUnifiedFetchOf(
  token: string,
  {
    cancelFileFetch,
    resetOnEmptyFetch,
    publish,
    appStateStore,
    fileFetchTimerRef,
    lastSearchTokenRef,
    agentsRef,
  }: {
    cancelFileFetch: () => void
    resetOnEmptyFetch: () => void
    publish: Publish
    appStateStore: AppStateStore
    fileFetchTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
    lastSearchTokenRef: React.MutableRefObject<string | null>
    agentsRef: React.MutableRefObject<AgentDefinition[] | undefined>
  },
): void {
  cancelFileFetch()
  fileFetchTimerRef.current = armTypeaheadTimer(() => {
    fileFetchTimerRef.current = null
    lastSearchTokenRef.current = token
    const state = appStateStore.getState()
    void generateUnifiedSuggestions(
      token,
      state.mcp.resources,
      agentsRef.current ?? [],
    )
      .then(results => {
        if (lastSearchTokenRef.current !== token) return
        if (results.length === 0) {
          resetOnEmptyFetch()
          return
        }
        publish(results, 'file')
      })
      .catch(error => logError(error))
  }, FILE_FETCH_DEBOUNCE_MS)
}

export function promptGhostOf({
  mode,
  input,
  cursorOffset,
  commands,
}: {
  mode: PromptInputMode
  input: string
  cursorOffset: number
  commands: Command[]
}): InlineGhostText | undefined {
  if (mode !== 'prompt') return undefined
  const midCommand = findMidInputSlashCommand(input, cursorOffset)
  if (!midCommand) return undefined
  const best = getBestCommandMatch(midCommand.partialCommand, commands)
  if (!best) return undefined
  return {
    text: best.suffix,
    fullCommand: best.fullCommand,
    insertPosition:
      midCommand.startPos + 1 + midCommand.partialCommand.length,
  }
}

export function rerunLadderOf(
  nextInput: string,
  {
    publish,
    clearSuggestions,
    runUnifiedFetch,
  }: {
    publish: Publish
    clearSuggestions: () => void
    runUnifiedFetch: (token: string) => void
  },
): void {
  const token = extractCompletionToken(nextInput, nextInput.length, true)
  if (!token) return
  const search = extractSearchToken(token)
  if (isPathLikeToken(search)) {
    void getPathCompletions(search, { maxResults: 10 })
      .then(entries => {
        if (entries.length > 0) publish(entries, 'directory')
        else clearSuggestions()
      })
      .catch(error => logError(error))
  } else {
    runUnifiedFetch(search)
  }
}
