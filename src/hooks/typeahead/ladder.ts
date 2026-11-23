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
  setSuggestionType: React.Dispatch<React.SetStateAction<SuggestionType>>
  setSuggestionsState: (
    update: SuggestionsState | ((prev: SuggestionsState) => SuggestionsState),
  ) => void
  setAsyncGhostText: React.Dispatch<React.SetStateAction<InlineGhostText | null>>
  inputRef: React.MutableRefObject<string>
  suggestionsRef: React.MutableRefObject<Suggestion[]>
  suggestionTypeRef: React.MutableRefObject<SuggestionType>
  lastBashInputRef: React.MutableRefObject<string | null>
  lastChannelQueryRef: React.MutableRefObject<string | null>
  lastPathQueryRef: React.MutableRefObject<string | null>
  lastSearchTokenRef: React.MutableRefObject<string | null>
  channelFetchTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>
}

export function ladderChannelTarget({
  input,
  cursor,
  mode,
  commands,
  publish,
  clearSuggestions,
}: LadderContext): boolean {
  if (mode !== 'prompt') return false
  const midCommand = findMidInputSlashCommand(input, cursor)
  if (midCommand && getBestCommandMatch(midCommand.partialCommand, commands)) {
    clearSuggestions()
    return true
  }
  const channelTarget = findChannelTargetQuery(input, cursor)
  if (!channelTarget) return false
  const seats = hasFocusedSession()
    ? (getFocusedSessionConnector().swarmBoard?.()?.seats ?? [])
    : (swarmView().seats ?? [])
  const candidates = channelTargetCandidates(channelTarget.kind, seats)
  const ranked = rankChannelTargets(channelTarget.query, candidates)
  if (ranked.length > 0) {
    publish(ranked, 'channel-target', { selected: 0 })
  } else {
    clearSuggestions()
  }
  return true
}

export function ladderMentions({
  input,
  cursor,
  mode,
  appStateStore,
  publish,
  clearSuggestions,
  cancelFileFetch,
  cancelChannelFetch,
  resetOnEmptyFetch,
  setSuggestionType,
  setSuggestionsState,
  setAsyncGhostText,
  suggestionTypeRef,
  lastBashInputRef,
  lastChannelQueryRef,
  channelFetchTimerRef,
}: LadderContext): boolean {
  if (mode === 'bash') {
    if (input.trim() !== '') {
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
    } else {
      lastBashInputRef.current = null
      setAsyncGhostText(null)
    }
    return false
  }

  const beforeCursor = input.slice(0, cursor)
  const agentMatch = beforeCursor.match(/(?:^|\s)@([\w-]*)$/)
  if (agentMatch) {
    const query = agentMatch[1]!.toLowerCase()
    const state = appStateStore.getState()
    const seen = new Set<string>()
    const agentSuggestions: Suggestion[] = []
    for (const name of state.agentNameRegistry.keys()) {
      if (seen.has(name)) continue
      seen.add(name)
      if (name.toLowerCase().startsWith(query)) {
        agentSuggestions.push({
          id: `dm-${name}`,
          displayText: `@${name}`,
          description: describeAgent(state, name),
        })
      }
    }
    if (agentSuggestions.length > 0) {
      cancelFileFetch()
      publish(agentSuggestions, 'agent')
      return true
    }
  }

  const channelMatch =
    mode === 'prompt'
      ? beforeCursor.match(/(?:^|\s)#([a-z0-9][a-z0-9_-]*)$/)
      : null
  if (channelMatch && hasSlackMcpServer(appStateStore.getState().mcp.clients)) {
    const query = channelMatch[1]!
    cancelChannelFetch()
    channelFetchTimerRef.current = armTypeaheadTimer(() => {
      channelFetchTimerRef.current = null
      lastChannelQueryRef.current = query
      const clients = appStateStore.getState().mcp.clients
      void getSlackChannelSuggestions(clients, query)
        .then(results => {
          if (lastChannelQueryRef.current !== query) return
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

  if (!channelMatch && suggestionTypeRef.current === 'slack-channel') {
    cancelChannelFetch()
    clearSuggestions()
  }

  return false
}

export function ladderCommands({
  input,
  cursor,
  mode,
  commands,
  publish,
  clearSuggestions,
  setSuggestionType,
  setSuggestionsState,
  inputRef,
}: LadderContext): boolean {
  if (mode !== 'prompt') return false

  const sessionsMatch = input.match(/^\/sessions\s+([\s\S]*)$/)
  if (sessionsMatch) {
    const query = sessionsMatch[1]!.trim()
    const expectedInput = input
    void searchSessionsByCustomTitle(query, { limit: RESUME_TITLE_LIMIT })
      .then(sessions => {
        if (inputRef.current !== expectedInput) return
        if (sessions.length === 0) {
          clearSuggestions()
          return
        }
        const items: Suggestion[] = sessions.map(session => {
          const label = session.customTitle || session.sessionId || ''
          return {
            id: label,
            displayText: label,
            description: formatLogMetadata(session),
            metadata: session.sessionId,
          }
        })
        publish(items, 'custom-title', { selected: 0 })
      })
      .catch(error => logError(error))
    return true
  }

  if (!input.startsWith('/') || cursor <= 0) return false

  const spaceIndex = input.indexOf(' ')
  if (hasCommandArgs(input)) {
    if (spaceIndex !== -1 && /\s$/.test(input)) {
      const cmdName = input.slice(1, spaceIndex)
      const rest = input.slice(spaceIndex + 1)
      const matched = commands.find(
        c => !c.isHidden && (c.userFacingName?.() === cmdName || c.name === cmdName),
      )
      if (matched && matched.type === 'prompt') {
        const argNames = parseArgumentNames(matched.argNames)
        const hint =
          argNames.length > 0
            ? generateProgressiveArgumentHint(argNames, parseArguments(rest))
            : undefined
        if (hint !== undefined) {
          setSuggestionType('none')
          setSuggestionsState({
            suggestions: [],
            selectedSuggestion: -1,
            commandArgumentHint: hint,
          })
          return true
        }
      }
    }
    return false
  }

  if (spaceIndex !== -1) {
    const cmdName = input.slice(1, spaceIndex)
    const rest = input.slice(spaceIndex + 1)
    const matched = commands.find(
      c => !c.isHidden && (c.userFacingName?.() === cmdName || c.name === cmdName),
    )
    if (matched || rest.trim() !== '') {
      let hint: string | undefined
      if (matched) {
        if (rest === '') {
          const argNames =
            matched.type === 'prompt' ? parseArgumentNames(matched.argNames) : []
          hint =
            matched.argumentHint ??
            (argNames.length > 0
              ? generateProgressiveArgumentHint(argNames, [])
              : undefined)
        } else if (/\s$/.test(input) && matched.type === 'prompt') {
          const argNames = parseArgumentNames(matched.argNames)
          hint =
            argNames.length > 0
              ? generateProgressiveArgumentHint(argNames, parseArguments(rest))
              : undefined
        }
      }
      if (hint !== undefined) {
        setSuggestionType('none')
        setSuggestionsState({
          suggestions: [],
          selectedSuggestion: -1,
          commandArgumentHint: hint,
        })
      } else {
        clearSuggestions()
      }
      return true
    }
  }

  const commandSuggestions = generateCommandSuggestions(input, commands)
  if (commandSuggestions.length === 0) {
    clearSuggestions()
    return true
  }

  let longest = 0
  for (const command of commands) {
    if (command.isHidden) continue
    const name = command.userFacingName?.() ?? command.name
    if (name.length > longest) longest = name.length
  }
  publish(commandSuggestions, 'command', {
    selected: 0,
    maxWidth: longest + 6,
  })
  return true
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

export function ladderPaths({
  input,
  cursor,
  mode,
  publish,
  clearSuggestions,
  cancelFileFetch,
  runUnifiedFetch,
  suggestionsRef,
  suggestionTypeRef,
  lastPathQueryRef,
  lastSearchTokenRef,
}: LadderContext): void {
  if (mode !== 'bash') {
    const token = extractCompletionToken(input, cursor, true)
    if (token && token.token.startsWith('@')) {
      const search = extractSearchToken(token)
      if (isPathLikeToken(search)) {
        lastPathQueryRef.current = search
        void getPathCompletions(search, { maxResults: 10 })
          .then(entries => {
            if (lastPathQueryRef.current !== search) return
            if (entries.length > 0) {
              publish(entries, 'directory')
            } else {
              clearSuggestions()
            }
          })
          .catch(error => logError(error))
      } else if (lastSearchTokenRef.current !== search) {
        runUnifiedFetch(search)
      }
      return
    }
    if (suggestionTypeRef.current === 'file') {
      if (token) {
        const search = extractSearchToken(token)
        if (lastSearchTokenRef.current !== search) {
          runUnifiedFetch(search)
        }
      } else {
        cancelFileFetch()
        clearSuggestions()
      }
      return
    }
    if (suggestionTypeRef.current === 'directory') {
      clearSuggestions()
      return
    }
  } else if (
    suggestionTypeRef.current === 'file' ||
    suggestionTypeRef.current === 'directory'
  ) {
    cancelFileFetch()
    clearSuggestions()
    return
  }

  if (suggestionTypeRef.current === 'shell') {
    const snapshotInput = shellMetadataOf(suggestionsRef.current[0]).input
    if (mode !== 'bash' || snapshotInput !== input) {
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
