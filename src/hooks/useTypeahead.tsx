
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { Command } from '../commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { getSelectedSuggestion } from '../components/PromptInput/suggestionSelectionStore.js'
import { useNotifications } from '../context/notifications.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useIsModalOverlayActive, useRegisterOverlay } from '../context/overlayContext.js'
import { anyModalOverlayActive } from '../context/overlayStack.js'
import { currentSurfaceRoute } from '../context/surfaceRoute.js'
import { useInput } from '../ink.js'
import { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js'
import { useAppStateStore } from '../state/AppState.js'
import type {
  InlineGhostText,
  PromptInputMode,
} from '../types/textInputTypes.js'
import { getShellCompletions, type ShellCompletionType } from '../utils/bash/shellCompletion.js'
import {
  generateProgressiveArgumentHint,
  parseArgumentNames,
  parseArguments,
} from '../utils/argumentSubstitution.js'
import {
  applyCommandSuggestion,
  isNameAnchoredSuggestion,
  findMidInputSlashCommand,
  generateCommandSuggestions,
  getBestCommandMatch,
  hasCommandArgs,
} from '../utils/suggestions/commandSuggestions.js'
import {
  getDirectoryCompletions,
  getPathCompletions,
  isPathLikeToken,
} from '../utils/suggestions/directoryCompletion.js'
import { getShellHistoryCompletion } from '../utils/suggestions/shellHistoryCompletion.js'
import {
  findSlackChannelPositions,
  getSlackChannelSuggestions,
  hasSlackMcpServer,
} from '../utils/suggestions/slackChannelSuggestions.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { TEAM_LEAD_NAME } from '../utils/swarm/constants.js'
import {
  findLongestCommonPrefix,
  generateFileSuggestions,
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from '../hooks/fileSuggestions.js'
import { generateUnifiedSuggestions } from '../hooks/unifiedSuggestions.js'
import { searchSessionsByCustomTitle } from '../utils/sessionStorage.js'
import { formatLogMetadata } from '../utils/format.js'
import { logError } from '../utils/log.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'


const liveTypeaheadTimers = new Set<ReturnType<typeof setTimeout>>()

export function typeaheadTimerCensus(): number {
  return liveTypeaheadTimers.size
}

export function armTypeaheadTimer(run: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    liveTypeaheadTimers.delete(timer)
    run()
  }, delayMs)
  liveTypeaheadTimers.add(timer)
  return timer
}

export function disarmTypeaheadTimer(timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer)
  liveTypeaheadTimers.delete(timer)
}

const FILE_FETCH_DEBOUNCE_MS = 50
const CHANNEL_FETCH_DEBOUNCE_MS = 150
const RESUME_TITLE_LIMIT = 10
const THINKING_HINT_KEY = 'thinking-toggle-hint'

export const SUGGESTION_TYPES = [
  'none',
  'command',
  'file',
  'directory',
  'custom-title',
  'shell',
  'agent',
  'slack-channel',
] as const

export type SuggestionsState = {
  suggestions: Suggestion[]
  selectedSuggestion: number
  commandArgumentHint?: string
}

export type UseTypeaheadProps = {
  input: string
  cursorOffset: number
  commands: Command[]
  mode: PromptInputMode
  agents: AgentDefinition[] | undefined
  suppressSuggestions?: boolean
  suggestionsState: SuggestionsState
  setSuggestionsState: (
    update: SuggestionsState | ((prev: SuggestionsState) => SuggestionsState),
  ) => void
  onInputChange: (value: string) => void
  setCursorOffset: (offset: number) => void
  onSubmit?: (value: string, isSubmittingSlashCommand?: boolean) => void
  onModeChange?: (mode: PromptInputMode) => void
  markAccepted?: () => void
}

export type UseTypeaheadResult = {
  suggestions: Suggestion[]
  selectedSuggestion: number
  suggestionType: SuggestionType
  maxColumnWidth: number | undefined
  commandArgumentHint: string | undefined
  inlineGhostText: InlineGhostText | undefined
  handleKeyboardEvent: (event: KeyboardEvent) => void
  acceptSuggestionAt: (index: number) => void
  hoverSuggestionAt: (index: number) => void
}

export function extractSearchToken({
  token,
  isQuoted,
}: {
  token: string
  isQuoted?: boolean
}): string {
  if (isQuoted) {
    let inner = token
    if (inner.startsWith('@')) inner = inner.slice(1)
    if (inner.startsWith('"')) inner = inner.slice(1)
    if (inner.endsWith('"')) inner = inner.slice(0, -1)
    return inner
  }
  return token.startsWith('@') ? token.slice(1) : token
}

export function formatReplacementValue({
  displayText,
  mode,
  hasAtPrefix,
  needsQuotes,
  isQuoted,
  isComplete,
}: {
  displayText: string
  mode: string
  hasAtPrefix: boolean
  needsQuotes: boolean
  isQuoted?: boolean
  isComplete: boolean
}): string {
  const suffix = isComplete ? ' ' : ''
  if (needsQuotes || isQuoted) {
    if (mode === 'bash') return `"${displayText}"${suffix}`
    return `@"${displayText}"${suffix}`
  }
  if (hasAtPrefix) return `@${displayText}${suffix}`
  return `${displayText}${suffix}`
}

export function applyShellSuggestion(
  suggestion: Suggestion,
  input: string,
  cursorOffset: number,
  onInputChange: (value: string) => void,
  setCursorOffset: (offset: number) => void,
  completionType: ShellCompletionType | undefined,
): void {
  const before = input.slice(0, cursorOffset)
  const lastSpace = before.lastIndexOf(' ')
  const wordStart = lastSpace + 1
  const prefix = completionType === 'variable' ? '$' : ''
  const suffix =
    completionType === 'variable' || completionType === 'command' ? ' ' : ''
  const replacement = prefix + suggestion.displayText + suffix
  const next =
    input.slice(0, wordStart) + replacement + input.slice(cursorOffset)
  onInputChange(next)
  setCursorOffset(wordStart + replacement.length)
}

export function applyDirectorySuggestion(
  input: string,
  suggestionId: string,
  tokenStartPos: number,
  tokenLength: number,
  isDirectory: boolean,
): { newInput: string; cursorPos: number } {
  const replacement = `@${suggestionId}${isDirectory ? '/' : ' '}`
  const newInput =
    input.slice(0, tokenStartPos) +
    replacement +
    input.slice(tokenStartPos + tokenLength)
  return { newInput, cursorPos: tokenStartPos + replacement.length }
}

type ShellSuggestionMetadata = {
  completionType?: ShellCompletionType
  input?: string
}

function shellMetadataOf(suggestion: Suggestion | undefined): ShellSuggestionMetadata {
  const metadata = suggestion?.metadata
  return metadata !== null && typeof metadata === 'object' ? (metadata as ShellSuggestionMetadata) : {}
}

function shellCompletionTypeOf(
  suggestion: Suggestion,
): ShellCompletionType | undefined {
  const { completionType } = shellMetadataOf(suggestion)
  if (
    completionType === 'command' ||
    completionType === 'variable' ||
    completionType === 'file'
  ) {
    return completionType
  }
  return undefined
}

const TOKEN_CHAR = /[^\s]/

export function extractCompletionToken(
  text: string,
  cursorPos: number,
  includeAtSymbol?: boolean,
): { token: string; startPos: number; isQuoted?: boolean } | null {
  if (!text) return null
  const clamped = Math.max(0, Math.min(cursorPos, text.length))

  if (includeAtSymbol) {
    for (let i = clamped - 1; i >= 0; i--) {
      if (text[i] === '@' && text[i + 1] === '"') {
        const closing = text.indexOf('"', i + 2)
        const endPos = closing === -1 ? text.length : closing + 1
        if (endPos >= clamped) {
          return {
            token: text.slice(i, endPos),
            startPos: i,
            isQuoted: true,
          }
        }
        break
      }
      if (text[i] === ' ' || text[i] === '\n') break
    }
    const before = text.slice(0, clamped)
    const at = before.lastIndexOf('@')
    if (at !== -1 && (at === 0 || /[\s]/.test(text[at - 1]!))) {
      const tail = before.slice(at + 1)
      if (!/\s/.test(tail)) {
        let end = clamped
        while (end < text.length && TOKEN_CHAR.test(text[end]!)) end++
        return { token: text.slice(at, end), startPos: at }
      }
    }
  }

  let start = clamped
  while (start > 0 && TOKEN_CHAR.test(text[start - 1]!)) start--
  let end = clamped
  while (end < text.length && TOKEN_CHAR.test(text[end]!)) end++
  if (start === end) return null
  return { token: text.slice(start, end), startPos: start }
}

function preservedSelection(
  next: Suggestion[],
  previous: Suggestion[],
  previousSelected: number,
): number {
  if (next.length === 0) return -1
  if (previousSelected < 0) return 0
  const previousId = previous[previousSelected]?.id
  if (previousId !== undefined) {
    const kept = next.findIndex(item => item.id === previousId)
    if (kept !== -1) return kept
  }
  return 0
}

export function useTypeahead(props: UseTypeaheadProps): UseTypeaheadResult {
  const {
    input,
    cursorOffset,
    commands,
    mode,
    suppressSuggestions,
    suggestionsState,
    setSuggestionsState,
    onInputChange: setInput,
    setCursorOffset,
    onSubmit,
    onModeChange,
    markAccepted,
  } = props
  const { suggestions, selectedSuggestion } = suggestionsState
  const argumentHint = suggestionsState.commandArgumentHint

  const { addNotification } = useNotifications()
  const appStateStore = useAppStateStore()
  const isModalOverlayActive = useIsModalOverlayActive()
  const keybindingContext = useOptionalKeybindingContext()
  const cockpitActive = useContext(CockpitActiveContext)

  const [suggestionType, setSuggestionType] = useState<SuggestionType>('none')
  const [maxColumnWidth, setMaxColumnWidth] = useState<number | undefined>(
    undefined,
  )
  const [asyncGhostText, setAsyncGhostText] = useState<InlineGhostText | null>(
    null,
  )

  const cursorOffsetRef = useRef(cursorOffset)
  cursorOffsetRef.current = cursorOffset
  const inputRef = useRef(input)
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  const suggestionTypeRef = useRef(suggestionType)
  suggestionTypeRef.current = suggestionType

  const agentsRef = useRef(props.agents)
  agentsRef.current = props.agents
  const dismissedForInputRef = useRef<string | null>(null)
  const userNavigatedRef = useRef(false)
  const lastSearchTokenRef = useRef<string | null>(null)
  const lastBashInputRef = useRef('')
  const lastPathQueryRef = useRef('')
  const lastChannelQueryRef = useRef('')

  const fileFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const cancelFileFetch = useCallback((): void => {
    if (fileFetchTimerRef.current) {
      disarmTypeaheadTimer(fileFetchTimerRef.current)
      fileFetchTimerRef.current = null
    }
  }, [])
  const cancelChannelFetch = useCallback((): void => {
    if (channelFetchTimerRef.current) {
      disarmTypeaheadTimer(channelFetchTimerRef.current)
      channelFetchTimerRef.current = null
    }
  }, [])

  useEffect(
    () => () => {
      cancelFileFetch()
      cancelChannelFetch()
    },
    [cancelFileFetch, cancelChannelFetch],
  )

  const publish = useCallback(
    (
      next: Suggestion[],
      type: SuggestionType,
      opts?: { selected?: number; maxWidth?: number; argumentHint?: string },
    ): void => {
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
    },
    [setSuggestionsState],
  )

  const clearSuggestions = useCallback((): void => {
    cancelFileFetch()
    setSuggestionType('none')
    setMaxColumnWidth(undefined)
    setAsyncGhostText(null)
    setSuggestionsState({ suggestions: [], selectedSuggestion: -1 })
  }, [cancelFileFetch, setSuggestionsState])

  const resetOnEmptyFetch = useCallback((): void => {
    setSuggestionType('none')
    setMaxColumnWidth(undefined)
    setSuggestionsState({ suggestions: [], selectedSuggestion: -1 })
  }, [setSuggestionsState])

  const runUnifiedFetch = useCallback(
    (token: string): void => {
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
    },
    [cancelFileFetch, publish, resetOnEmptyFetch],
  )

  useEffect(() => {
    startBackgroundCacheRefresh()
    return onIndexBuildComplete(() => {
      const token = lastSearchTokenRef.current
      if (token === null) return
      lastSearchTokenRef.current = null
      runUnifiedFetch(token)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const cursor = cursorOffsetRef.current

    if (suppressSuggestions) {
      cancelFileFetch()
      clearSuggestions()
      return
    }
    if (dismissedForInputRef.current === input) return
    dismissedForInputRef.current = null
    if (inputRef.current !== input) {
      inputRef.current = input
      lastSearchTokenRef.current = null
    }

    if (mode === 'prompt') {
      const midCommand = findMidInputSlashCommand(input, cursor)
      if (
        midCommand &&
        getBestCommandMatch(midCommand.partialCommand, commands)
      ) {
        clearSuggestions()
        return
      }
    }

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
        if (isAgentSwarmsEnabled() && state.teamContext) {
          for (const name of Object.keys(state.teamContext.teammates ?? {})) {
            if (name === TEAM_LEAD_NAME) continue
            if (!name.toLowerCase().startsWith(fragment)) continue
            if (seen.has(name)) continue
            seen.add(name)
            members.push({
              id: `dm-${name}`,
              displayText: `@${name}`,
              description: describeAgent(state, name),
            })
          }
        }
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
          return
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
          return
        }
        if (!channel && suggestionTypeRef.current === 'slack-channel') {
          cancelChannelFetch()
          clearSuggestions()
        }
      }
    }

    if (mode === 'prompt') {
      const addDir = input.match(/^\/add-dir\s+(\S.*)$/)
      if (addDir) {
        const argument = addDir[1]!
        if (/\s$/.test(input)) {
          clearSuggestions()
          return
        }
        void getDirectoryCompletions(argument)
          .then(entries => {
            if (inputRef.current !== input) return
            if (entries.length === 0) {
              clearSuggestions()
              return
            }
            publish(entries, 'directory')
          })
          .catch(error => logError(error))
        return
      }

      const resume = input.match(/^\/resume\s+(.*)$/)
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
        return
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
            return
          }
        }
        const liveState = appStateStore.getState()
        const generated = generateCommandSuggestions(input, commands, {
          effortValue: liveState.effortValue,
          permissionMode: liveState.toolPermissionContext?.mode,
          mainLoopModelForSession: liveState.mainLoopModelForSession,
        })
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
        return
      }
    }

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, mode, suppressSuggestions, commands])

  function describeAgent(
    state: ReturnType<typeof appStateStore.getState>,
    name: string,
  ): string {
    const taskId = state.agentNameRegistry.get(name)
    if (taskId) {
      const task = state.tasks[taskId]
      if (task?.status) return `send a message · ${task.status}`
    }
    return 'send a message'
  }

  const promptGhost = useMemo((): InlineGhostText | undefined => {
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
  }, [mode, input, cursorOffset, commands])

  const inlineGhostText = suppressSuggestions
    ? undefined
    : mode === 'prompt'
      ? promptGhost
      : (asyncGhostText ?? undefined)


  const rerunLadderForInput = useCallback(
    (nextInput: string): void => {
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
    },
    [publish, clearSuggestions, runUnifiedFetch],
  )

  const acceptSuggestion = useCallback(
    (atIndex: number | undefined, viaEnter: boolean): void => {
      const currentInput = inputRef.current
      const cursor = cursorOffsetRef.current
      const list = suggestionsRef.current
      const type = suggestionTypeRef.current

      const ghost =
        mode === 'prompt' ? promptGhost : (asyncGhostText ?? undefined)
      if (ghost && !viaEnter) {
        if (mode === 'bash') {
          setInput(ghost.fullCommand)
          setCursorOffset(ghost.fullCommand.length)
          setAsyncGhostText(null)
          return
        }
        const midCommand = findMidInputSlashCommand(
          currentInput,
          cursorOffsetRef.current,
        )
        if (midCommand) {
          const before = currentInput.slice(0, midCommand.startPos)
          const after = currentInput.slice(
            midCommand.startPos + 1 + midCommand.partialCommand.length,
          )
          const replaced = `${before}/${ghost.fullCommand} `
          setInput(replaced + after)
          setCursorOffset(replaced.length)
          clearSuggestions()
          return
        }
      }

      if (list.length > 0) {
        cancelFileFetch()
        cancelChannelFetch()
        const selectedSuggestion = getSelectedSuggestion()
        const index = atIndex ?? (selectedSuggestion === -1 ? 0 : selectedSuggestion)
        const suggestion = list[Math.min(index, list.length - 1)]
        if (!suggestion) return

        switch (type) {
          case 'command': {
            if (
              viaEnter &&
              atIndex === undefined &&
              !userNavigatedRef.current &&
              !isNameAnchoredSuggestion(currentInput, suggestion)
            ) {
              clearSuggestions()
              onSubmit?.(currentInput, true)
              return
            }
            applyCommandSuggestion(
              suggestion,
              viaEnter,
              commands,
              setInput,
              setCursorOffset,
              onSubmit ?? (() => {}),
            )
            clearSuggestions()
            return
          }
          case 'custom-title': {
            const sessionRef =
              (suggestion.metadata as string | undefined) ??
              suggestion.displayText
            const rebuilt = `/resume ${sessionRef}`
            setInput(rebuilt)
            setCursorOffset(rebuilt.length)
            if (viaEnter) onSubmit?.(rebuilt, true)
            clearSuggestions()
            return
          }
          case 'directory': {
            if (currentInput.startsWith('/')) {
              if (viaEnter) {
                clearSuggestions()
                return
              }
              const spaceIndex = currentInput.indexOf(' ')
              const prefix = currentInput.slice(0, spaceIndex + 1)
              const isDirectory = suggestion.id.endsWith('/')
              const id = isDirectory
                ? suggestion.id.slice(0, -1)
                : suggestion.id
              const rebuilt = `${prefix}${id}${isDirectory ? '/' : ' '}`
              setInput(rebuilt)
              setCursorOffset(rebuilt.length)
              if (isDirectory) rerunLadderForInput(rebuilt)
              else clearSuggestions()
              return
            }
            const token = extractCompletionToken(currentInput, cursor, true)
            if (!token) {
              clearSuggestions()
              return
            }
            const isDirectory = suggestion.id.endsWith('/')
            const id = isDirectory ? suggestion.id.slice(0, -1) : suggestion.id
            const { newInput, cursorPos } = applyDirectorySuggestion(
              currentInput,
              id,
              token.startPos,
              token.token.length,
              isDirectory,
            )
            setInput(newInput)
            setCursorOffset(cursorPos)
            if (isDirectory && !viaEnter) rerunLadderForInput(newInput)
            else clearSuggestions()
            return
          }
          case 'shell': {
            applyShellSuggestion(
              suggestion,
              currentInput,
              cursor,
              setInput,
              setCursorOffset,
              shellCompletionTypeOf(suggestion),
            )
            clearSuggestions()
            return
          }
          case 'agent': {
            if (!suggestion.id.startsWith('dm-')) return
            const before = currentInput.slice(0, cursor)
            const match = before.match(/(^|\s)@[\w-]*$/)
            if (!match) {
              clearSuggestions()
              return
            }
            const start = before.length - match[0].length + match[1]!.length
            const rebuilt =
              currentInput.slice(0, start) +
              suggestion.displayText +
              ' ' +
              currentInput.slice(cursor)
            setInput(rebuilt)
            setCursorOffset(start + suggestion.displayText.length + 1)
            clearSuggestions()
            return
          }
          case 'slack-channel': {
            const before = currentInput.slice(0, cursor)
            const match = before.match(/(^|\s)#[a-z0-9][a-z0-9_-]*$/)
            if (!match) {
              clearSuggestions()
              return
            }
            const start = before.length - match[0].length + match[1]!.length
            const rebuilt =
              currentInput.slice(0, start) +
              suggestion.displayText +
              ' ' +
              currentInput.slice(cursor)
            setInput(rebuilt)
            setCursorOffset(start + suggestion.displayText.length + 1)
            clearSuggestions()
            return
          }
          case 'file': {
            const token = extractCompletionToken(currentInput, cursor, true)
            if (!token) {
              clearSuggestions()
              return
            }
            const search = extractSearchToken(token)
            const commonPrefix = findLongestCommonPrefix(list)
            if (
              !viaEnter &&
              commonPrefix.length > search.length &&
              list.length > 1
            ) {
              const partial = formatReplacementValue({
                displayText: commonPrefix,
                mode,
                hasAtPrefix: token.token.startsWith('@'),
                needsQuotes: commonPrefix.includes(' '),
                isQuoted: token.isQuoted,
                isComplete: false,
              })
              const rebuilt =
                currentInput.slice(0, token.startPos) +
                partial +
                currentInput.slice(token.startPos + token.token.length)
              setInput(rebuilt)
              setCursorOffset(token.startPos + partial.length)
              runUnifiedFetch(commonPrefix)
              return
            }
            const complete = formatReplacementValue({
              displayText: suggestion.displayText,
              mode,
              hasAtPrefix: token.token.startsWith('@'),
              needsQuotes: suggestion.displayText.includes(' '),
              isQuoted: token.isQuoted,
              isComplete: true,
            })
            const rebuilt =
              currentInput.slice(0, token.startPos) +
              complete +
              currentInput.slice(token.startPos + token.token.length)
            setInput(rebuilt)
            setCursorOffset(token.startPos + complete.length)
            clearSuggestions()
            return
          }
          default:
            return
        }
      }

      if (currentInput.trim() === '') return
      if (mode === 'bash') {
        void getShellCompletions(currentInput, cursor, new AbortController().signal)
          .then(completions => {
            if (completions.length === 1) {
              applyShellSuggestion(
                completions[0]!,
                inputRef.current,
                cursorOffsetRef.current,
                setInput,
                setCursorOffset,
                shellCompletionTypeOf(completions[0]!),
              )
              return
            }
            if (completions.length > 0) {
              publish(
                completions.map((completion, index) =>
                  index === 0
                    ? {
                        ...completion,
                        metadata: { ...shellMetadataOf(completion), input: inputRef.current },
                      }
                    : completion,
                ),
                'shell',
                { selected: 0 },
              )
            }
          })
          .catch(error => logError(error))
        return
      }
      const token = extractCompletionToken(currentInput, cursor, true)
      if (!token) return
      runUnifiedFetch(extractSearchToken(token))
    },
    [
      mode,
      commands,
      promptGhost,
      asyncGhostText,
      setInput,
      setCursorOffset,
      onSubmit,
      publish,
      clearSuggestions,
      cancelFileFetch,
      cancelChannelFetch,
      rerunLadderForInput,
      runUnifiedFetch,
    ],
  )

  const hasSuggestionsOrGhost =
    suggestions.length > 0 || inlineGhostText !== undefined

  useRegisterOverlay('autocomplete', hasSuggestionsOrGhost)

  const moveSelection = useCallback(
    (delta: number): void => {
      const list = suggestionsRef.current
      if (list.length === 0) return
      userNavigatedRef.current = true
      const current = getSelectedSuggestion()
      const next = (current + delta + list.length) % list.length
      setSuggestionsState(prev => ({ ...prev, selectedSuggestion: next }))
    },
    [setSuggestionsState],
  )

  useKeybindings(
    {
      'autocomplete:accept': () => {
        if (isModalOverlayActive) return false
        if (!hasSuggestionsOrGhost) return false
        acceptSuggestion(undefined, false)
      },
      'autocomplete:dismiss': () => {
        if (isModalOverlayActive) return false
        if (!hasSuggestionsOrGhost) return false
        cancelFileFetch()
        cancelChannelFetch()
        dismissedForInputRef.current = inputRef.current
        clearSuggestions()
      },
      'autocomplete:previous': () => {
        if (isModalOverlayActive) return false
        if (suggestionsRef.current.length === 0) return false
        moveSelection(-1)
      },
      'autocomplete:next': () => {
        if (isModalOverlayActive) return false
        if (suggestionsRef.current.length === 0) return false
        moveSelection(1)
      },
    },
    { context: 'Autocomplete', isActive: hasSuggestionsOrGhost },
  )

  const acceptPromptSuggestion = useCallback((): void => {
    const state = appStateStore.getState()
    const promptSuggestion = state.promptSuggestion
    if (!promptSuggestion?.text) return
    markAccepted?.()
    const text = promptSuggestion.text
    const { getModeFromInput, getValueFromInput } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../components/PromptInput/inputModes.js') as typeof import('../components/PromptInput/inputModes.js')
    const impliedMode = getModeFromInput(text)
    if (impliedMode !== 'prompt' && onModeChange) {
      onModeChange(impliedMode)
      const stripped = getValueFromInput(text)
      setInput(stripped)
      setCursorOffset(stripped.length)
    } else {
      setInput(text)
      setCursorOffset(text.length)
    }
  }, [appStateStore, markAccepted, onModeChange, setInput, setCursorOffset])

  const handleKeyboardEvent = useCallback(
    (event: KeyboardEvent): void => {
      const state = appStateStore.getState()
      const viewingTeammate = Boolean(state.viewingAgentTaskId)
      const promptSuggestion = state.promptSuggestion

      if (
        event.key === 'right' &&
        !viewingTeammate &&
        promptSuggestion?.text &&
        (promptSuggestion.shownAt ?? 0) > 0 &&
        inputRef.current === ''
      ) {
        acceptPromptSuggestion()
        event.stopImmediatePropagation()
        return
      }

      if (event.key === 'tab' && !event.shift) {
        if (
          suggestionsRef.current.length > 0 ||
          inlineGhostText !== undefined
        ) {
          return
        }
        if (
          !viewingTeammate &&
          promptSuggestion?.text &&
          inputRef.current === ''
        ) {
          event.stopImmediatePropagation()
          acceptPromptSuggestion()
          return
        }
        if (inputRef.current.trim() === '') {
          if (cockpitActive) return
          event.stopImmediatePropagation()
          const chord = getShortcutDisplay('chat:thinkingToggle', 'Chat', 'meta+t')
          addNotification({
            key: THINKING_HINT_KEY,
            text: `${chord} toggles thinking`,
            priority: 'immediate',
            timeoutMs: 3000,
          })
        }
        return
      }

      if (suggestionsRef.current.length === 0) return

      if (event.ctrl && (event.key === 'n' || event.key === 'p')) {
        if (keybindingContext?.pendingChord) return
        event.stopImmediatePropagation()
        moveSelection(event.key === 'n' ? 1 : -1)
        return
      }

      if (event.key === 'return' && !event.shift && !event.meta) {
        event.stopImmediatePropagation()
        acceptSuggestion(undefined, true)
      }
    },
    [
      appStateStore,
      inlineGhostText,
      acceptPromptSuggestion,
      moveSelection,
      acceptSuggestion,
      addNotification,
      keybindingContext,
    ],
  )

  useInput(
    (input_, key, event) => {
      void input_
      void key
      if (currentSurfaceRoute().kind !== 'repl') return
      if (anyModalOverlayActive()) return
      const adapter = new KeyboardEvent(event.keypress)
      handleKeyboardEvent(adapter)
      if (adapter.didStopImmediatePropagation()) {
        event.stopImmediatePropagation()
      }
    },
    { isActive: hasSuggestionsOrGhost || mode === 'prompt' },
  )

  const acceptSuggestionAt = useCallback(
    (index: number): void => {
      acceptSuggestion(index, false)
    },
    [acceptSuggestion],
  )

  const hoverSuggestionAt = useCallback(
    (index: number): void => {
      if (getSelectedSuggestion() === index) return
      setSuggestionsState(prev => ({ ...prev, selectedSuggestion: index }))
    },
    [setSuggestionsState],
  )

  return {
    suggestions,
    selectedSuggestion,
    suggestionType,
    maxColumnWidth,
    commandArgumentHint: argumentHint,
    inlineGhostText,
    handleKeyboardEvent,
    acceptSuggestionAt,
    hoverSuggestionAt,
  }
}
