
import { useCallback, useContext, useMemo, useRef, useState } from 'react'
import { useClaim, useLoad, useSubscription } from './effects.js'
import type { Command } from '../commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { getSelectedSuggestion } from '../components/PromptInput/suggestionSelectionStore.js'
import { useNotifications } from '../context/notifications.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useIsModalOverlayActive, useRegisterOverlay } from '../context/overlayContext.js'
import { useInput } from '../ink.js'
import type { KeyboardEvent } from '../ink/events/keyboard-event.js'
import { useOptionalKeybindingContext } from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useAppStateStore } from '../state/AppState.js'
import type {
  InlineGhostText,
  PromptInputMode,
} from '../types/textInputTypes.js'
import {
  findChannelTargetQuery,
} from '../utils/suggestions/commandSuggestions.js'
import { subscribeThroughFocused } from '../services/engine-connector/focusedConnector.js'
import {
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from '../hooks/fileSuggestions.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { disarmTypeaheadTimer } from './typeahead/timers.js'
import { ladderChannelTarget, ladderClearStale, ladderCommands, ladderMentions, ladderPaths, type LadderContext } from './typeahead/ladder.js'
import type { SuggestionsState } from './typeahead/state.js'
import { acceptAgent, acceptChannelTarget, acceptCommand, acceptGhost, acceptCustomTitle, acceptDirectory, acceptFile, acceptShell, acceptSlackChannel, acceptWithoutList, type AcceptContext } from './typeahead/accept.js'
import { acceptPromptSuggestionOf, handleTypeaheadKey, routeTypeaheadInput, typeaheadKeybindings } from './typeahead/keys.js'
import { promptGhostOf, publishSuggestionsOf, rerunLadderOf, runUnifiedFetchOf } from './typeahead/fetch.js'


export { armTypeaheadTimer, disarmTypeaheadTimer, typeaheadTimerCensus } from './typeahead/timers.js'



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

  useClaim(
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
      publishSuggestionsOf(next, type, opts, { setSuggestionType, setMaxColumnWidth, setSuggestionsState, userNavigatedRef, suggestionsRef })
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
      runUnifiedFetchOf(token, { cancelFileFetch, resetOnEmptyFetch, publish, appStateStore, fileFetchTimerRef, lastSearchTokenRef, agentsRef })
    },
    [cancelFileFetch, publish, resetOnEmptyFetch],
  )

  useSubscription(() => {
    startBackgroundCacheRefresh()
    return onIndexBuildComplete(() => {
      const token = lastSearchTokenRef.current
      if (token === null) return
      lastSearchTokenRef.current = null
      runUnifiedFetch(token)
    })
  }, [])

  useSubscription(
    () =>
      subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))(() => {
        if (findChannelTargetQuery(inputRef.current, cursorOffsetRef.current)) setRosterStamp(stamp => stamp + 1)
      }),
    [],
  )

  useLoad(() => {
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
    return promptGhostOf({ mode, input, cursorOffset, commands })
  }, [mode, input, cursorOffset, commands])

  const inlineGhostText = suppressSuggestions
    ? undefined
    : mode === 'prompt'
      ? promptGhost
      : (asyncGhostText ?? undefined)


  const rerunLadderForInput = useCallback(
    (nextInput: string): void => {
      rerunLadderOf(nextInput, { publish, clearSuggestions, runUnifiedFetch })
    },
    [publish, clearSuggestions, runUnifiedFetch],
  )

  const acceptSuggestion = useCallback(
    (atIndex: number | undefined, viaEnter: boolean): void => {
      const currentInput = inputRef.current
      const cursor = cursorOffsetRef.current
      const list = suggestionsRef.current
      const type = suggestionTypeRef.current
      const accept: AcceptContext = { atIndex, viaEnter, currentInput, cursor, list, mode, commands, setInput, setCursorOffset, onSubmit, publish, clearSuggestions, runUnifiedFetch, rerunLadderForInput, userNavigatedRef, inputRef, cursorOffsetRef, promptGhost, asyncGhostText, setAsyncGhostText }

      if (acceptGhost(accept)) return

      if (list.length > 0) {
        cancelFileFetch()
        cancelChannelFetch()
        const selectedSuggestion = getSelectedSuggestion()
        const index = atIndex ?? (selectedSuggestion === -1 ? 0 : selectedSuggestion)
        const suggestion = list[Math.min(index, list.length - 1)]
        if (!suggestion) return

        switch (type) {
          case 'command': return acceptCommand(accept, suggestion)
          case 'custom-title': return acceptCustomTitle(accept, suggestion)
          case 'directory': return acceptDirectory(accept, suggestion)
          case 'shell': return acceptShell(accept, suggestion)
          case 'channel-target': return acceptChannelTarget(accept, suggestion)
          case 'agent': return acceptAgent(accept, suggestion)
          case 'slack-channel': return acceptSlackChannel(accept, suggestion)
          case 'file': return acceptFile(accept, suggestion)
          default:
            return
        }
      }

      acceptWithoutList(accept)
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
    typeaheadKeybindings({ isModalOverlayActive, hasSuggestionsOrGhost, acceptSuggestion, cancelFileFetch, cancelChannelFetch, clearSuggestions, moveSelection, dismissedForInputRef, inputRef, suggestionsRef }),
    { context: 'Autocomplete', isActive: hasSuggestionsOrGhost },
  )

  const acceptPromptSuggestion = useCallback((): void => {
    acceptPromptSuggestionOf({ appStateStore, markAccepted, onModeChange, setInput, setCursorOffset })
  }, [appStateStore, markAccepted, onModeChange, setInput, setCursorOffset])

  const handleKeyboardEvent = useCallback(
    (event: KeyboardEvent): void => {
      handleTypeaheadKey(event, { appStateStore, inputRef, suggestionsRef, inlineGhostText, cockpitActive, addNotification, keybindingContext, acceptPromptSuggestion, moveSelection, acceptSuggestion })
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
      routeTypeaheadInput(input_, key, event, handleKeyboardEvent)
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
