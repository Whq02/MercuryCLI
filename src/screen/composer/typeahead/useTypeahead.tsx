import { useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useClaim, useLoad } from '../../effects/effects.js'
import type { Command } from '../../../commands/catalogue/commands.js'
import type {
  SuggestionItem as Suggestion,
  SuggestionType,
} from '../ComposerFooterSuggestions.js'
import { getSelectedSuggestion } from '../suggestionSelectionStore.js'
import { useNotifications } from '../../notifications/notifications.js'
import { CockpitActiveContext } from '../../cockpit/cockpitActiveContext.js'
import { useIsModalOverlayActive, useRegisterOverlay } from '../../overlays/overlayHooks.js'
import { useInput } from '../../themedRenderer.js'
import type { KeyboardEvent } from '../../renderer/events/keyboard-event.js'
import { useOptionalKeybindingContext } from '../../keys/KeybindingContext.js'
import { useKeybindings } from '../../keys/useKeybinding.js'
import { useAppStateStore } from '../../app-state/AppState.js'
import type {
  InlineGhostText,
  PromptInputMode,
} from '../input-core/textInput.js'
import {
  findChannelTargetQuery,
} from '../../suggestions/commandSuggestions.js'
import { getFocusedSessionConnector, hasFocusedSession, subscribeThroughFocused } from '../../../engine/connector/focusedConnector.js'
import {
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from './fileSuggestions.js'
import type { AgentDefinition } from '../../../crew/agents/agentDefinition.js'
import { disarmTypeaheadTimer } from './timers.js'
import { ladderChannelTarget, ladderClearStale, ladderCommands, ladderMentions, ladderPaths, type LadderContext } from './ladder.js'
import type { SuggestionsState } from './state.js'
import { acceptAgent, acceptChannelTarget, acceptCommand, acceptGhost, acceptCustomTitle, acceptDirectory, acceptFile, acceptShell, acceptSlackChannel, acceptWithoutList, type AcceptContext } from './accept.js'
import { acceptPromptSuggestionOf, handleTypeaheadKey, routeTypeaheadInput, typeaheadKeybindings } from './keys.js'
import { promptGhostOf, publishSuggestionsOf, rerunLadderOf, runUnifiedFetchOf } from './fetch.js'

const NOOP_SUBSCRIBE = (): (() => void) => () => {}
const subscribeFocusedWork = subscribeThroughFocused((connector, listener) => connector.subscribeWork(listener))

export { armTypeaheadTimer, disarmTypeaheadTimer, typeaheadTimerCensus } from './timers.js'

export type { SuggestionsState } from './state.js'

type UseTypeaheadProps = {
  input: string
  cursorOffset: number
  mode: PromptInputMode
  commands: Command[]
  agents?: AgentDefinition[]
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
  maxColumnWidth?: number
  commandArgumentHint?: string
  inlineGhostText?: InlineGhostText
  handleKeyboardEvent: (event: KeyboardEvent) => void
  acceptSuggestionAt: (index: number) => void
  hoverSuggestionAt: (index: number) => void
}

function dispatchAcceptedSuggestion(
  type: SuggestionType,
  ctx: AcceptContext,
  suggestion: Suggestion,
): void {
  switch (type) {
    case 'command':
      acceptCommand(ctx, suggestion)
      break
    case 'custom-title':
      acceptCustomTitle(ctx, suggestion)
      break
    case 'directory':
      acceptDirectory(ctx, suggestion)
      break
    case 'shell':
      acceptShell(ctx, suggestion)
      break
    case 'channel-target':
      acceptChannelTarget(ctx, suggestion)
      break
    case 'agent':
      acceptAgent(ctx, suggestion)
      break
    case 'slack-channel':
      acceptSlackChannel(ctx, suggestion)
      break
    case 'file':
      acceptFile(ctx, suggestion)
      break
    default:
      break
  }
}

function runTypeaheadLadder(ctx: LadderContext): void {
  if (ladderChannelTarget(ctx)) return
  if (ladderMentions(ctx)) return
  if (ladderCommands(ctx)) return
  ladderClearStale(ctx)
  ladderPaths(ctx)
}

function acceptWithContext(
  ctx: AcceptContext,
  suggestionType: SuggestionType,
  cancelFileFetch: () => void,
  cancelChannelFetch: () => void,
): void {
  if (acceptGhost(ctx)) return
  if (ctx.list.length > 0) {
    cancelFileFetch()
    cancelChannelFetch()
    const rawIndex = ctx.atIndex !== undefined ? ctx.atIndex : getSelectedSuggestion()
    const selectedIndex = Math.min(rawIndex === -1 ? 0 : rawIndex, ctx.list.length - 1)
    const suggestion = ctx.list[selectedIndex]
    if (!suggestion) return
    dispatchAcceptedSuggestion(suggestionType, ctx, suggestion)
    return
  }
  acceptWithoutList(ctx)
}

export function useTypeahead({
  input,
  cursorOffset,
  mode,
  commands,
  agents,
  suppressSuggestions = false,
  suggestionsState,
  setSuggestionsState,
  onInputChange,
  setCursorOffset,
  onSubmit,
  onModeChange,
  markAccepted,
}: UseTypeaheadProps): UseTypeaheadResult {
  const [suggestionType, setSuggestionType] = useState<SuggestionType>('none')
  const [maxColumnWidth, setMaxColumnWidth] = useState<number | undefined>(undefined)
  const [asyncGhostText, setAsyncGhostText] = useState<InlineGhostText | null>(null)

  const appStateStore = useAppStateStore()
  const { addNotification } = useNotifications()
  const cockpitActive = useContext(CockpitActiveContext)
  const keybindingContext = useOptionalKeybindingContext()
  const isModalOverlayActive = useIsModalOverlayActive()

  const cursorOffsetRef = useRef(cursorOffset)
  cursorOffsetRef.current = cursorOffset
  const suggestionsRef = useRef(suggestionsState.suggestions)
  suggestionsRef.current = suggestionsState.suggestions
  const suggestionTypeRef = useRef(suggestionType)
  suggestionTypeRef.current = suggestionType
  const agentsRef = useRef(agents)
  agentsRef.current = agents
  const inputRef = useRef(input)
  inputRef.current = input
  const commandArgumentHintRef = useRef(suggestionsState.commandArgumentHint)
  commandArgumentHintRef.current = suggestionsState.commandArgumentHint

  const fileFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const channelFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSearchTokenRef = useRef<string | null>(null)
  const lastBashInputRef = useRef<string | null>(null)
  const lastChannelQueryRef = useRef<string | null>(null)
  const lastPathQueryRef = useRef<string | null>(null)
  const dismissedForInputRef = useRef<string | null>(null)
  const userNavigatedRef = useRef(false)

  const cancelFileFetch = useCallback(() => {
    if (fileFetchTimerRef.current !== null) {
      disarmTypeaheadTimer(fileFetchTimerRef.current)
      fileFetchTimerRef.current = null
    }
  }, [])

  const cancelChannelFetch = useCallback(() => {
    if (channelFetchTimerRef.current !== null) {
      disarmTypeaheadTimer(channelFetchTimerRef.current)
      channelFetchTimerRef.current = null
    }
  }, [])

  const clearSuggestions = useCallback(() => {
    lastSearchTokenRef.current = null
    setSuggestionType('none')
    setMaxColumnWidth(undefined)
    setAsyncGhostText(null)
    setSuggestionsState({ suggestions: [], selectedSuggestion: -1 })
  }, [setSuggestionsState])

  const resetOnEmptyFetch = useCallback(() => {
    setSuggestionType('none')
    setMaxColumnWidth(undefined)
    setSuggestionsState({ suggestions: [], selectedSuggestion: -1 })
  }, [setSuggestionsState])

  const publish = useCallback(
    (
      next: Suggestion[],
      type: SuggestionType,
      opts?: { selected?: number; maxWidth?: number; argumentHint?: string },
    ) => {
      publishSuggestionsOf(next, type, opts, {
        setSuggestionType,
        setMaxColumnWidth,
        setSuggestionsState,
        userNavigatedRef,
        suggestionsRef,
      })
    },
    [setSuggestionsState],
  )

  const runUnifiedFetch = useCallback(
    (token: string) => {
      runUnifiedFetchOf(token, {
        cancelFileFetch,
        resetOnEmptyFetch,
        publish,
        appStateStore,
        fileFetchTimerRef,
        lastSearchTokenRef,
        agentsRef,
      })
    },
    [cancelFileFetch, resetOnEmptyFetch, publish, appStateStore],
  )

  const rerunLadderForInput = useCallback(
    (nextInput: string) => {
      rerunLadderOf(nextInput, { publish, clearSuggestions, runUnifiedFetch })
    },
    [publish, clearSuggestions, runUnifiedFetch],
  )

  const runUnifiedFetchRef = useRef(runUnifiedFetch)
  runUnifiedFetchRef.current = runUnifiedFetch

  useClaim(() => () => { cancelFileFetch(); cancelChannelFetch() }, [cancelFileFetch, cancelChannelFetch])

  useClaim(() => {
    startBackgroundCacheRefresh()
    return onIndexBuildComplete(() => {
      const token = lastSearchTokenRef.current
      if (token !== null) runUnifiedFetchRef.current(token)
    })
  }, [])

  const hasChannelTargetQuery = mode === 'prompt' && findChannelTargetQuery(input, cursorOffset) !== null

  const focusedSwarmBoard = useSyncExternalStore(
    hasChannelTargetQuery ? subscribeFocusedWork : NOOP_SUBSCRIBE,
    () => (hasChannelTargetQuery && hasFocusedSession() ? (getFocusedSessionConnector().swarmBoard?.() ?? null) : null),
  )

  useLoad(() => {
    if (suppressSuggestions) {
      cancelFileFetch()
      clearSuggestions()
      return
    }
    if (dismissedForInputRef.current !== null) {
      if (dismissedForInputRef.current === input) return
      dismissedForInputRef.current = null
      lastSearchTokenRef.current = null
    }
    runTypeaheadLadder({
      input,
      cursor: cursorOffsetRef.current,
      mode,
      commands,
      argumentHint: commandArgumentHintRef.current,
      appStateStore,
      publish,
      clearSuggestions,
      cancelFileFetch,
      cancelChannelFetch,
      resetOnEmptyFetch,
      runUnifiedFetch,
      setSuggestionType,
      setSuggestionsState,
      setAsyncGhostText,
      inputRef,
      suggestionsRef,
      suggestionTypeRef,
      lastBashInputRef,
      lastChannelQueryRef,
      lastPathQueryRef,
      lastSearchTokenRef,
      channelFetchTimerRef,
    })
  }, [input, mode, suppressSuggestions, commands, focusedSwarmBoard, appStateStore, publish, clearSuggestions, cancelFileFetch, cancelChannelFetch, resetOnEmptyFetch, runUnifiedFetch, setSuggestionsState])

  const promptGhost = useMemo(() => promptGhostOf({ mode, input, cursorOffset, commands }), [mode, input, cursorOffset, commands])
  const inlineGhostText: InlineGhostText | undefined = suppressSuggestions
    ? undefined
    : mode === 'prompt'
      ? promptGhost
      : (asyncGhostText ?? undefined)

  const moveSelection = useCallback(
    (delta: number) => {
      if (suggestionsRef.current.length === 0) return
      userNavigatedRef.current = true
      setSuggestionsState(prev => {
        const count = prev.suggestions.length
        if (count === 0) return prev
        const current = getSelectedSuggestion()
        const base = current < 0 ? (delta > 0 ? -1 : 0) : current
        return { ...prev, selectedSuggestion: (((base + delta) % count) + count) % count }
      })
    },
    [setSuggestionsState],
  )

  const acceptSuggestion = useCallback(
    (atIndex: number | undefined, viaEnter: boolean) => {
      acceptWithContext(
        {
          atIndex,
          viaEnter,
          currentInput: inputRef.current,
          cursor: cursorOffsetRef.current,
          list: suggestionsRef.current,
          mode,
          commands,
          setInput: onInputChange,
          setCursorOffset,
          onSubmit,
          publish,
          clearSuggestions,
          runUnifiedFetch,
          rerunLadderForInput,
          userNavigatedRef,
          inputRef,
          cursorOffsetRef,
          promptGhost,
          asyncGhostText,
          setAsyncGhostText,
        },
        suggestionTypeRef.current,
        cancelFileFetch,
        cancelChannelFetch,
      )
    },
    [mode, commands, onInputChange, setCursorOffset, onSubmit, publish, clearSuggestions, runUnifiedFetch, rerunLadderForInput, promptGhost, asyncGhostText, cancelFileFetch, cancelChannelFetch],
  )

  const acceptSuggestionAt = useCallback((index: number) => { acceptSuggestion(index, false) }, [acceptSuggestion])

  const hoverSuggestionAt = useCallback(
    (index: number) => {
      if (getSelectedSuggestion() === index) return
      setSuggestionsState(prev => (prev.selectedSuggestion === index ? prev : { ...prev, selectedSuggestion: index }))
    },
    [setSuggestionsState],
  )

  const acceptPromptSuggestion = useCallback(() => {
    acceptPromptSuggestionOf({ appStateStore, markAccepted, onModeChange, setInput: onInputChange, setCursorOffset })
  }, [appStateStore, markAccepted, onModeChange, onInputChange, setCursorOffset])

  const handleKeyboardEvent = useCallback(
    (event: KeyboardEvent) => {
      handleTypeaheadKey(event, { appStateStore, inputRef, suggestionsRef, inlineGhostText, cockpitActive, addNotification, keybindingContext, acceptPromptSuggestion, moveSelection, acceptSuggestion })
    },
    [appStateStore, inlineGhostText, cockpitActive, addNotification, keybindingContext, acceptPromptSuggestion, moveSelection, acceptSuggestion],
  )

  const hasSuggestionsOrGhost = suggestionsState.suggestions.length > 0 || inlineGhostText !== undefined

  useRegisterOverlay('autocomplete', hasSuggestionsOrGhost)

  const keybindingHandlers = useMemo(
    () => typeaheadKeybindings({ isModalOverlayActive, hasSuggestionsOrGhost, acceptSuggestion, cancelFileFetch, cancelChannelFetch, clearSuggestions, moveSelection, dismissedForInputRef, inputRef, suggestionsRef }),
    [isModalOverlayActive, hasSuggestionsOrGhost, acceptSuggestion, cancelFileFetch, cancelChannelFetch, clearSuggestions, moveSelection],
  )

  useKeybindings(keybindingHandlers, { context: 'Autocomplete', isActive: hasSuggestionsOrGhost && !isModalOverlayActive })

  useInput(
    (input_, key, event) => { routeTypeaheadInput(input_, key, event, handleKeyboardEvent) },
    { isActive: (hasSuggestionsOrGhost || mode === 'prompt') && !isModalOverlayActive },
  )

  return {
    suggestions: suggestionsState.suggestions,
    selectedSuggestion: suggestionsState.selectedSuggestion,
    suggestionType,
    maxColumnWidth,
    commandArgumentHint: suggestionsState.commandArgumentHint,
    inlineGhostText,
    handleKeyboardEvent,
    acceptSuggestionAt,
    hoverSuggestionAt,
  }
}
