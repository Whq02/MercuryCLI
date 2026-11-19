
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
import { getShellCompletions } from '../utils/bash/shellCompletion.js'
import {
  applyCommandSuggestion,
  findChannelTargetQuery,
  isNameAnchoredSuggestion,
  findMidInputSlashCommand,
  getBestCommandMatch,
} from '../utils/suggestions/commandSuggestions.js'
import { subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import {
  getPathCompletions,
  isPathLikeToken,
} from '../utils/suggestions/directoryCompletion.js'
import {
  findLongestCommonPrefix,
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from '../hooks/fileSuggestions.js'
import { generateUnifiedSuggestions } from '../hooks/unifiedSuggestions.js'
import { logError } from '../utils/log.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { armTypeaheadTimer, disarmTypeaheadTimer } from './typeahead/timers.js'
import {
  applyDirectorySuggestion,
  applyShellSuggestion,
  extractCompletionToken,
  extractSearchToken,
  formatReplacementValue,
  preservedSelection,
  shellCompletionTypeOf,
  shellMetadataOf,
} from './typeahead/tokens.js'
import { ladderChannelTarget, ladderClearStale, ladderCommands, ladderMentions, ladderPaths, type LadderContext } from './typeahead/ladder.js'
import type { SuggestionsState } from './typeahead/state.js'


export { armTypeaheadTimer, disarmTypeaheadTimer, typeaheadTimerCensus } from './typeahead/timers.js'

const FILE_FETCH_DEBOUNCE_MS = 50
const THINKING_HINT_KEY = 'thinking-toggle-hint'


export type { SuggestionsState } from './typeahead/state.js'

type UseTypeaheadProps = {
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

type UseTypeaheadResult = {
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
  const [rosterStamp, setRosterStamp] = useState(0)

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
  }, [])

  useEffect(
    () =>
      subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))(() => {
        if (findChannelTargetQuery(inputRef.current, cursorOffsetRef.current)) setRosterStamp(stamp => stamp + 1)
      }),
    [],
  )

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

    const ladder: LadderContext = { input, cursor, mode, commands, argumentHint, appStateStore, publish, clearSuggestions, cancelFileFetch, cancelChannelFetch, resetOnEmptyFetch, runUnifiedFetch, setAsyncGhostText, setSuggestionsState, setSuggestionType, inputRef, suggestionsRef, suggestionTypeRef, lastBashInputRef, lastChannelQueryRef, lastPathQueryRef, lastSearchTokenRef, channelFetchTimerRef }
    if (ladderChannelTarget(ladder)) return
    if (ladderMentions(ladder)) return
    if (ladderCommands(ladder)) return
    ladderClearStale(ladder)
    ladderPaths(ladder)
  }, [input, mode, suppressSuggestions, commands, rosterStamp])

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
            const rebuilt = `/sessions ${sessionRef}`
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
          case 'channel-target': {
            const target = findChannelTargetQuery(currentInput, cursor)
            if (!target) {
              clearSuggestions()
              return
            }
            const rebuilt = `${currentInput.slice(0, target.start)}${String(suggestion.metadata ?? suggestion.displayText)} `
            setInput(rebuilt)
            setCursorOffset(rebuilt.length)
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
      const viewingCrewmate = Boolean(state.viewingAgentTaskId)
      const promptSuggestion = state.promptSuggestion

      if (
        event.key === 'right' &&
        !viewingCrewmate &&
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
          !viewingCrewmate &&
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
