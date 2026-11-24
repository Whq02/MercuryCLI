import type React from 'react'
import type { Command } from '../../../commands/catalogue/commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../ComposerFooterSuggestions.js'
import { swarmView } from '../../../crew/board/seam.js'
import { getFocusedSessionConnector, hasFocusedSession } from '../../../engine/connector/focusedConnector.js'
import type { AppStateStore } from '../../app-state/AppStateStore.js'
import type { InlineGhostText, InputMode } from '../input-core/textInput.js'
import {
  generateProgressiveArgumentHint,
  parseArgumentNames,
  parseArguments,
} from '../../../integrations/extensions/load/argumentSubstitution.js'
import { formatListingMetadata } from '../../../platform/text/format.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { searchSessionsByCustomTitle } from '../../../sessions/transcripts/sessionStorage.js'
import {
  channelTargetCandidates,
  findChannelTargetQuery,
  findMidInputSlashCommand,
  generateCommandSuggestions,
  getBestCommandMatch,
  hasCommandArgs,
  rankChannelTargets,
} from '../../suggestions/commandSuggestions.js'
import { isPathLikeToken } from '../../suggestions/pathCompletion.js'
import { getShellHistoryCompletion } from '../../suggestions/shellHistoryCompletion.js'
import {
  getSlackChannelSuggestions,
  hasSlackMcpServer,
} from '../../slack-suggestions/slackChannelSuggestions.js'
import { runPathFetchOf } from './fetch.js'
import type { Publish, SuggestionsState } from './state.js'
import { armTypeaheadTimer } from './timers.js'
import { extractCompletionToken, extractSearchToken, shellMetadataOf } from './tokens.js'

const CHANNEL_FETCH_DEBOUNCE_MS = 150
const RESUME_TITLE_LIMIT = 10

export type LadderContext = {
  input: string
  cursor: number
  mode: InputMode
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
          description: describeCrewmate(state, name),
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

function progressiveHintOf(
  command: Command | undefined,
  input: string,
  name: string,
  rest: string,
): string | undefined {
  if (command === undefined) return undefined
  if (command.argumentHint && input === `/${name} `) return command.argumentHint
  if (!/\s$/.test(input)) return undefined
  return generateProgressiveArgumentHint(
    parseArgumentNames(command.argumentHint ?? ''),
    parseArguments(rest),
  )
}

export function ladderCommands({
  input,
  cursor,
  mode,
  commands,
  publish,
  clearSuggestions,
  inputRef,
}: LadderContext): boolean {
  if (mode !== 'prompt') return false

  const sessionsMatch = input.match(/^\/sessions\s+(.*)$/)
  if (sessionsMatch) {
    void searchSessionsByCustomTitle(sessionsMatch[1]!, { limit: RESUME_TITLE_LIMIT })
      .then(sessions => {
        if (inputRef.current !== input) return
        if (sessions.length === 0) {
          clearSuggestions()
          return
        }
        const items: Suggestion[] = sessions.map(session => {
          const label = session.customTitle ?? session.sessionId ?? ''
          return {
            id: label,
            displayText: label,
            description: formatListingMetadata(session),
            metadata: session.sessionId,
          }
        })
        publish(items, 'custom-title')
      })
      .catch(error => logError(error))
    return true
  }

  if (!input.startsWith('/') || cursor <= 0 || hasCommandArgs(input)) return false

  const spaceIndex = input.indexOf(' ')
  if (spaceIndex !== -1) {
    const name = input.slice(1, spaceIndex)
    const rest = input.slice(spaceIndex + 1)
    const command = commands.find(c => c.userFacingName?.() === name || c.name === name)
    if (command !== undefined || rest.trim() !== '') {
      const hint = progressiveHintOf(command, input, name, rest)
      publish([], 'none', {
        selected: -1,
        ...(hint !== undefined ? { argumentHint: hint } : {}),
      })
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
        runPathFetchOf(search, { publish, clearSuggestions, lastPathQueryRef })
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

function describeCrewmate(
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
