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

const CHANNEL_FETCH_DEBOUNCE_MS = 150
const RESUME_TITLE_LIMIT = 10

export type LadderContext = {
  input: string
  cursor: number
  mode: PromptInputMode
  commands: Command[]
  argumentHint: string | undefined
  appStateStore: AppStateStore
  publish: Publish
  clearSuggestions: () => void
  cancelFileFetch: () => void
  cancelChannelFetch: () => void
  resetOnEmptyFetch: () => void
  runUnifiedFetch: (token: string) => void
  setAsyncGhostText: React.Dispatch<React.SetStateAction<InlineGhostText | null>>
  setSuggestionsState: (
    update: SuggestionsState | ((prev: SuggestionsState) => SuggestionsState),
  ) => void
  setSuggestionType: React.Dispatch<React.SetStateAction<SuggestionType>>
  inputRef: React.MutableRefObject<string>
  suggestionsRef: React.MutableRefObject<Suggestion[]>
  suggestionTypeRef: React.MutableRefObject<SuggestionType>
  lastBashInputRef: React.MutableRefObject<string>
  lastChannelQueryRef: React.MutableRefObject<string>
  lastPathQueryRef: React.MutableRefObject<string>
  lastSearchTokenRef: React.MutableRefObject<string | null>
  channelFetchTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
}

export function ladderChannelTarget({ input, cursor, mode, commands, clearSuggestions, publish }: LadderContext): boolean {
  if (mode === 'prompt') {
    const midCommand = findMidInputSlashCommand(input, cursor)
    if (
      midCommand &&
      getBestCommandMatch(midCommand.partialCommand, commands)
    ) {
      clearSuggestions()
      return true
    }
    const target = findChannelTargetQuery(input, cursor)
    if (target) {
      const seats = (hasFocusedSession() ? getFocusedSessionConnector().swarmBoard?.()?.seats : swarmView().seats) ?? []
      const items = rankChannelTargets(target.query, channelTargetCandidates(target.kind, seats))
      if (items.length > 0) publish(items, 'channel-target', { selected: 0 })
      else clearSuggestions()
      return true
    }
  }
  return false
}

export function ladderMentions({ input, cursor, mode, appStateStore, publish, clearSuggestions, cancelFileFetch, cancelChannelFetch, resetOnEmptyFetch, setAsyncGhostText, setSuggestionsState, setSuggestionType, suggestionTypeRef, lastBashInputRef, lastChannelQueryRef, channelFetchTimerRef }: LadderContext): boolean {
  if (mode === 'bash' && input.trim() !== '') {
    lastBashInputRef.current = input
    void getShellHistoryCompletion(input)
      .then(match => {
        if (lastBashInputRef.current !== input) return
        if (match) {
          setAsyncGhostText({
            text: match.suffix,
            fullCommand: match.fullCommand,
            insertPosition: input.length,
          })
          setSuggestionsState({ suggestions: [], selectedSuggestion: -1 })
          setSuggestionType('none')
        } else {
          setAsyncGhostText(null)
        }
      })
      .catch(error => logError(error))
  } else if (mode !== 'bash') {
    const beforeCursor = input.slice(0, cursor)
    const mention = beforeCursor.match(/(^|\s)@([\w-]*)$/)
    if (mention) {
      const fragment = mention[2]!.toLowerCase()
      const state = appStateStore.getState()
      const members: Suggestion[] = []
      const seen = new Set<string>()
      for (const name of state.agentNameRegistry.keys()) {
        if (seen.has(name)) continue
        if (!name.toLowerCase().startsWith(fragment)) continue
        seen.add(name)
        members.push({
          id: `dm-${name}`,
          displayText: `@${name}`,
          description: describeAgent(state, name),
        })
      }
      if (members.length > 0) {
        cancelFileFetch()
        publish(members, 'agent')
        return true
      }
    }

    if (mode === 'prompt') {
      const channel = beforeCursor.match(/(^|\s)#([a-z0-9][a-z0-9_-]*)$/)
      if (channel && hasSlackMcpServer(appStateStore.getState().mcp.clients)) {
        const fragment = channel[2]!
        cancelChannelFetch()
        channelFetchTimerRef.current = armTypeaheadTimer(() => {
          channelFetchTimerRef.current = null
          lastChannelQueryRef.current = fragment
          void getSlackChannelSuggestions(
            appStateStore.getState().mcp.clients,
            fragment,
          )
            .then(results => {
              if (lastChannelQueryRef.current !== fragment) return
              if (results.length === 0) {
                resetOnEmptyFetch()
                return
              }
              publish(results, 'slack-channel')
            })
            .catch(error => logError(error))
        }, CHANNEL_FETCH_DEBOUNCE_MS)
        return true
      }
      if (!channel && suggestionTypeRef.current === 'slack-channel') {
        cancelChannelFetch()
        clearSuggestions()
      }
    }
  }
  return false
}

export function ladderCommands({ input, cursor, mode, commands, publish, clearSuggestions, inputRef }: LadderContext): boolean {
  if (mode === 'prompt') {
    const resume = input.match(/^\/sessions\s+(.*)$/)
    if (resume) {
      void searchSessionsByCustomTitle(resume[1]!, { limit: RESUME_TITLE_LIMIT })
        .then(sessions => {
          if (inputRef.current !== input) return
          if (sessions.length === 0) {
            clearSuggestions()
            return
          }
          publish(
            sessions.map(session => ({
              id: session.customTitle ?? session.sessionId ?? '',
              displayText: session.customTitle ?? session.sessionId ?? '',
              description: formatLogMetadata(session),
              metadata: session.sessionId,
            })),
            'custom-title',
          )
        })
        .catch(error => logError(error))
      return true
    }

    if (
      input.startsWith('/') &&
      cursor > 0 &&
      !hasCommandArgs(input)
    ) {
      const spaceIndex = input.indexOf(' ')
      if (spaceIndex !== -1) {
        const name = input.slice(1, spaceIndex)
        const rest = input.slice(spaceIndex + 1)
        const exact = commands.some(
          command => command.userFacingName?.() === name || command.name === name,
        )
        if (exact || rest.trim() !== '') {
          let hint: string | undefined
          const command = commands.find(
            c => c.userFacingName?.() === name || c.name === name,
          )
          if (command?.argumentHint && input === `/${name} `) {
            hint = command.argumentHint
          } else if (command && /\s$/.test(input)) {
            hint =
              generateProgressiveArgumentHint(
                parseArgumentNames(command.argumentHint ?? ''),
                parseArguments(rest),
              ) ?? undefined
          }
          publish([], 'none', {
            selected: -1,
            ...(hint !== undefined ? { argumentHint: hint } : {}),
          })
          return true
        }
      }
      const generated = generateCommandSuggestions(input, commands)
      if (generated.length > 0) {
        const longest = Math.max(
          0,
          ...commands
            .filter(command => !command.isHidden)
            .map(command => (command.userFacingName?.() ?? command.name).length),
        )
        publish(generated, 'command', {
          selected: 0,
          maxWidth: longest + 6,
        })
      } else {
        clearSuggestions()
      }
      return true
    }
  }
  return false
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

export function ladderPaths({ input, cursor, mode, publish, clearSuggestions, cancelFileFetch, runUnifiedFetch, suggestionsRef, suggestionTypeRef, lastPathQueryRef, lastSearchTokenRef }: LadderContext): void {
  if (mode !== 'bash') {
    const token = extractCompletionToken(input, cursor, true)
    if (token?.token.startsWith('@')) {
      const search = extractSearchToken(token)
      if (isPathLikeToken(search)) {
        lastPathQueryRef.current = search
        void getPathCompletions(search, { maxResults: 10 })
          .then(entries => {
            if (lastPathQueryRef.current !== search) return
            if (entries.length > 0) publish(entries, 'directory')
          })
          .catch(error => logError(error))
        return
      }
      if (lastSearchTokenRef.current === search) return
      runUnifiedFetch(search)
      return
    }
  }

  if (suggestionTypeRef.current === 'file') {
    const token = extractCompletionToken(input, cursor, true)
    if (token) {
      const search = extractSearchToken(token)
      if (lastSearchTokenRef.current !== search) runUnifiedFetch(search)
    } else {
      cancelFileFetch()
      clearSuggestions()
    }
    return
  }

  if (suggestionTypeRef.current === 'shell') {
    const snapshot = shellMetadataOf(suggestionsRef.current[0]).input
    if (mode !== 'bash' || snapshot !== input) {
      cancelFileFetch()
      clearSuggestions()
    }
  }
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
