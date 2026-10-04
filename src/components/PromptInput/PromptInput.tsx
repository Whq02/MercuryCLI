
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text } from '../../ink.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useNotifications } from '../../context/notifications.js'
import {
  currentSurfaceRoute,
  subscribeSurfaceRoute,
  surfaceRouteVersion,
} from '../../context/surfaceRoute.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js'
import { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import { useTypeahead, type SuggestionsState } from '../../hooks/useTypeahead.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { holdToTalkKey, setHoldToTalkEditor } from '../../services/voice/holdToTalk.js'
import { subscribeVoice, voiceSnapshot } from '../../services/voice/voiceSession.js'
import { useAppState, useAppStateStore, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  enterCrewmateView,
  exitCrewmateView,
} from '../../state/crewmateViewHelpers.js'
import { useComposerCrewmate, useViewedCrewmate } from '../tasks/useCrewmateView.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { PastedContent } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import type { VimMode } from '../../types/textInputTypes.js'
import {
  consumeCommandDispatch,
  consumeHelmActivation,
  consumePromptPrefill,
  getHelmFocus,
  getHelmVersion,
  setHelmFocus,
  subscribeHelmFocus,
} from '../../utils/cockpit/helmFocus.js'
import {
  beginConsoleCompose,
} from '../../utils/cockpit/helmConsole.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'
import { useCrewBanner } from './useCrewBanner.js'
import { isVimModeEnabled } from './utils.js'
import HistorySearchInput from './HistorySearchInput.js'
import { PromptInputFooter } from './PromptInputFooter.js'
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js'
import { PromptInputStashNotice } from './PromptInputStashNotice.js'
import {
  getSelectedSuggestion,
  setSelectedSuggestionStore,
} from './suggestionSelectionStore.js'
import { Notifications } from './Notifications.js'
import { IssueFlagBanner } from './IssueFlagBanner.js'
import TextInput from '../TextInput.js'
import VimTextInput from '../VimTextInput.js'
import { ThinkingToggle } from '../ThinkingToggle.js'
import { MercuryCommandPalette } from '../MercuryCommandPalette.js'
import { MercuryFileOpen } from '../MercuryFileOpen.js'
import type { OverlaySurface } from './composerOverlay.js'
import { useComposerModelDoors } from './useComposerModelDoors.js'
import { useComposerSubmit } from './useComposerSubmit.js'
import { useComposerRawKeys } from './useComposerRawKeys.js'
import { useComposerAttachments } from './useComposerAttachments.js'
import { useComposerKeybindings } from './useComposerKeybindings.js'
import { useComposerSelectionRoad, useComposerSelectionState } from './useComposerSelection.js'
import { useComposerDraft } from './useComposerDraft.js'
import { MercuryContentSearch } from '../MercuryContentSearch.js'
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getViewedCrewmateTask } from '../../state/selectors.js'
import { isCrewEnabled } from '../../utils/crewEnabled.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useFocusedTranscript } from '../../hooks/useFocusedTranscript.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js'
import { findSlackChannelPositions } from '../../utils/suggestions/slackChannelSuggestions.js'
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import { parseReferences } from '../../history.js'
import { composerEffortNotice } from './composerEffortNotice.js'
import { useFocusedBornEffort, useFocusedSentEffort, useFocusedServedEffort } from '../../hooks/useDisplayedSessionModel.js'
import { isDefaultMode } from '../../utils/permissions/PermissionMode.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { CompactFrameBudgetContext, useLayoutChrome } from '../../context/layoutChromeContext.js'
import { CompactWorkSummary, type CompactWorkControls, type CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js'
import { anyModalOverlayActive, topOverlay } from '../../context/overlayStack.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import { composerBorderRole, composerBorderStyle } from '../mercury-ui/composerFloor.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { openFilesMenu } from '../../utils/cockpit/filesMenu.js'
import { popupOwnsKeys, subscribePopupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { AMBER } from '../mercuryPalette.js'
import type { Key } from '../../ink/events/input-event.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { fluxMark, fluxWhy } from '../../utils/flux/fluxProbe.js'

const LOST_LINE_NOTICE_MS = 8000

export type PromptInputProps = {
  compactWork?: CompactWorkControls
  compactFocus?: CompactWorkFocus
  debug: boolean
  toolPermissionContext: AppState['toolPermissionContext']
  setToolPermissionContext: (
    context: AppState['toolPermissionContext'],
    options?: { preserveMode?: boolean },
  ) => void
  apiKeyStatus: VerificationStatus
  commands: Command[]
  agents: AgentDefinition[] | undefined
  isLoading: boolean
  verbose: boolean
  submitCount: number
  onShowMessageSelector: () => void
  onMessageActionsEnter?: () => void
  mcpClients: MCPServerConnection[]
  vimMode: VimMode
  setVimMode: React.Dispatch<React.SetStateAction<VimMode>>
  showBashesDialog: string | boolean
  setShowBashesDialog: React.Dispatch<React.SetStateAction<string | boolean>>
  onExit: () => void
  getToolUseContext: (
    messages: Message[],
    tools: never[],
    abortController: AbortController,
    model: string,
  ) => LocalJSXCommandContext
  onSubmit: (
    input: string,
    helpers: PromptInputHelpers,
    speculationAccept?: {
      state: unknown
      speculationSessionTimeSavedMs: number
      setAppState: (f: (prev: AppState) => AppState) => void
    },
    options?: { fromKeybinding?: boolean },
  ) => Promise<void>
  isSearchingHistory: boolean
  setIsSearchingHistory: (searching: boolean) => void
  helpOpen: boolean
  setHelpOpen: (open: boolean) => void
  hasSuppressedDialogs: boolean
  isLocalJSXCommandActive: boolean
  insertTextRef: React.MutableRefObject<{
    insert: (text: string) => void
    setInputWithCursor: (value: string, cursor: number) => void
    cursorOffset: number
  } | null>
  onAgentSubmit?: (text: string) => void
}

const subscribeFocusedComposerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedComposerMainModel = (): string => getFocusedSessionConnector().modelFacts().main
const getFocusedComposerEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective

function PromptInputInner(props: PromptInputProps): React.ReactNode {
  fluxMark('render:composer')
  const {
    compactWork,
    compactFocus = 'composer',
    debug,
    toolPermissionContext,
    setToolPermissionContext,
    apiKeyStatus,
    commands,
    agents,
    isLoading,
    verbose,
    submitCount,
    onShowMessageSelector,
    onMessageActionsEnter,
    mcpClients,
    vimMode,
    setVimMode,
    showBashesDialog,
    setShowBashesDialog,
    onExit,
    getToolUseContext,
    onSubmit,
    isSearchingHistory,
    setIsSearchingHistory,
    helpOpen,
    setHelpOpen,
    hasSuppressedDialogs,
    isLocalJSXCommandActive,
    insertTextRef,
    onAgentSubmit,
  } = props

  const tokens = useMercuryTokens()
  const composerBloom = tokens.accentSoft
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const { columns, rows } = useTerminalSize()
  const { isCompact } = useLayoutChrome()
  const compactBudget = useContext(CompactFrameBudgetContext)
  const keybindings = useOptionalKeybindingContext()
  const pastePendingRef = useRef<(() => boolean) | null>(null)
  const summaryVisible = isCompact && (compactBudget?.summaryRows ?? 0) > 0
  const { addNotification, removeNotification } = useNotifications()
  const setAppState = useSetAppState()
  const appStateStore = useAppStateStore()
  const messages = useFocusedTranscript() as Message[]
  const engineModel = useAppState((s: AppState) => s.engineModel)
  const engineModelForSession = useAppState(
    (s: AppState) => s.engineModelForSession,
  )
  const effortValue = useAppState((s: AppState) => s.effortValue)
  const viewedTask = useAppState((s: AppState) =>
    s.viewingAgentTaskId !== undefined ? s.tasks[s.viewingAgentTaskId] : undefined,
  )
  const footerSelection = useAppState((s: AppState) => s.footerSelection)
  const viewSelectionMode = useAppState((s: AppState) => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState((s: AppState) => s.viewingAgentTaskId)
  const crewContext = useAppState((s: AppState) => s.crewContext)
  const promptSuggestionEnabled = useAppState(
    (s: AppState) => s.promptSuggestionEnabled,
  )
  const speculationActive = useAppState(
    (s: AppState) =>
      (s as { speculation?: { status?: string } }).speculation?.status === 'active',
  )
  const fullscreen = isFullscreenEnvEnabled()
  const cockpitActive = useContext(CockpitActiveContext)

  const draft = useComposerDraft({
    helpOpen,
    setHelpOpen,
    speculationActive,
    footerSelection,
    setAppState,
    addNotification,
    removeNotification,
  })
  const {
    editGen,
    input,
    mode,
    pastedContents,
    stash,
    cursorOffset,
    setCursorOffset,
    lastSelfWriteRef,
    writeDraft,
    buffer,
    setMode,
    setPastedContents,
    deferredSpaceArmedRef,
    deferredSpaceShiftRef,
    onChange,
  } = draft
  const focusedMainModel = useSyncExternalStore(
    subscribeFocusedComposerModel,
    getFocusedComposerMainModel,
    getFocusedComposerMainModel,
  )
  const focusedEffectiveModel = useSyncExternalStore(
    subscribeFocusedComposerModel,
    getFocusedComposerEffectiveModel,
    getFocusedComposerEffectiveModel,
  )
  const seatEffort = useFocusedServedEffort()
  const sentEffort = useFocusedSentEffort()
  const bornEffort = useFocusedBornEffort()
  const voice = useSyncExternalStore(subscribeVoice, voiceSnapshot, voiceSnapshot)
  const voiceReceiptSeqRef = useRef(0)
  useEffect(() => {
    const receipt = voice.receipt
    if (receipt === null || receipt.seq === voiceReceiptSeqRef.current) return
    voiceReceiptSeqRef.current = receipt.seq
    addNotification({
      key: 'voice-receipt',
      text: receipt.text,
      priority: 'immediate',
      ...(receipt.tone === 'error' ? { color: 'error' as const } : {}),
      timeoutMs: 8000,
    })
  }, [voice.receipt, addNotification])
  const composerWhyRef = useRef<Record<string, unknown> | null>(null)
  fluxWhy('composer', composerWhyRef, () => ({
    ...props,
    messages,
    editGen,
    focusedMainModel,
    tokens,
    themeName,
    columns,
    rows,
    engineModel,
    engineModelForSession,
    effortValue,
    viewedTask,
    footerSelection,
    viewSelectionMode,
    viewingAgentTaskId,
    crewContext,
    promptSuggestionEnabled,
    speculationActive,
    cockpitActive,
    addNotification,
    removeNotification,
    setAppState,
    appStateStore,
  }))
  const selection = useComposerSelectionState()
  const { inputSelectionRangeRef, inputBoxRef, selectionApi, clearOwnSelection } = selection

  const [overlay, setOverlay] = useState<OverlaySurface>(null)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showFileOpen, setShowFileOpen] = useState(false)
  const [showContentSearch, setShowContentSearch] = useState(false)
  const [externalEditorActive, setExternalEditorActive] = useState(false)
  const [exitState, setExitState] = useState<{ pending: boolean; keyName: string | null }>({ pending: false, keyName: null })
  const [isPasting, setIsPasting] = useState(false)

  const popupUp = useSyncExternalStore(subscribePopupOwnsKeys, popupOwnsKeys, popupOwnsKeys)
  const modalOverlayUp =
    overlay !== null ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive ||
    hasSuppressedDialogs ||
    popupUp

  const canFocusSummary = (): boolean => summaryVisible && currentSurfaceRoute().kind === 'repl' && !modalOverlayUp && !externalEditorActive && !isSearchingHistory && !helpOpen && !exitState.pending && !anyModalOverlayActive() && !(pastePendingRef.current?.() ?? false)
  compactWork?.bindToggle(() => {
    if (compactWork.read() === 'summary') { compactWork.set('composer'); return }
    if (canFocusSummary()) compactWork.set('summary')
  })
  useEffect(() => () => compactWork?.bindToggle(null), [compactWork])
  useLayoutEffect(() => {
    if (isCompact && footerSelection !== null) setAppState(prev => ({ ...prev, footerSelection: null }))
  }, [isCompact, footerSelection, setAppState])
  useLayoutEffect(() => {
    if (compactWork?.read() === 'summary' && !canFocusSummary()) compactWork.set('composer')
  }, [summaryVisible, modalOverlayUp, externalEditorActive, isSearchingHistory, helpOpen, exitState.pending, compactWork])

  const doors = useComposerModelDoors({
    overlay,
    setOverlay,
    messages,
    modalOverlayUp,
    engineModel,
    engineModelForSession,
    focusedMainModel,
    focusedEffectiveModel,
    isCompact,
    columns,
    appStateStore,
    setAppState,
    addNotification,
  })
  const { capLaneLine, capLaneCut } = doors

  const viewedCrewmateTask = getViewedCrewmateTask(
    appStateStore.getState(),
  )
  const composerCrewmate = useComposerCrewmate()
  const composerCrewmateRef = useRef(composerCrewmate)
  composerCrewmateRef.current = composerCrewmate
  const viewedCrewmate = useViewedCrewmate()
  const viewedCrewmateRef = useRef(viewedCrewmate)
  viewedCrewmateRef.current = viewedCrewmate
  const viewedAgentName =
    composerCrewmate?.name ??
    viewedCrewmateTask?.identity?.agentName ??
    (viewedTask !== undefined && isLocalAgentTask(viewedTask)
      ? viewedTask.description !== ''
        ? viewedTask.description
        : viewedTask.agentType
      : undefined)
  const viewedAgentColor = viewedCrewmateTask?.identity?.color


  const suggestionApi = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  })
  const suggestionDisplayable =
    suggestionApi.suggestion !== null && mode === 'prompt' && !viewedAgentName
  const markSuggestionShown = suggestionApi.markShown
  useEffect(() => {
    if (suggestionDisplayable) markSuggestionShown()
  }, [suggestionDisplayable, markSuggestionShown])

  const attachments = useComposerAttachments({
    input,
    cursorOffset,
    pastedContents,
    buffer,
    messages,
    rows,
    inputSelectionRangeRef,
    writeDraft,
    setCursorOffset,
    setMode,
    setPastedContents,
    addNotification,
    deferredSpaceArmedRef,
    insertTextRef,
  })
  const { insertAtCursor, insertAtomic, handleImagePaste, handleImageError, handleTextPaste, cursorRef } = attachments

  const [suggestionsState, setSuggestionsStateRaw] = useState<SuggestionsState>({
    suggestions: [],
    selectedSuggestion: 0,
  })
  const suggestionsMirrorRef = useRef(suggestionsState)
  const setSuggestionsState = useCallback(
    (
      update:
        | SuggestionsState
        | ((prev: SuggestionsState) => SuggestionsState),
    ): void => {
      const previous = suggestionsMirrorRef.current
      const next =
        typeof update === 'function' ? update(previous) : update
      setSelectedSuggestionStore(next.selectedSuggestion)
      if (
        next.suggestions !== previous.suggestions ||
        next.commandArgumentHint !== previous.commandArgumentHint
      ) {
        suggestionsMirrorRef.current = next
        setSuggestionsStateRaw(next)
      } else {
        suggestionsMirrorRef.current = {
          ...previous,
          selectedSuggestion: next.selectedSuggestion,
        }
      }
    },
    [],
  )

  const historyRecallActiveRef = useRef(false)
  const typeahead = useTypeahead({
    input,
    cursorOffset,
    commands,
    mode,
    agents,
    suppressSuggestions: isSearchingHistory || historyRecallActiveRef.current,
    suggestionsState,
    setSuggestionsState,
    onInputChange: onChange,
    setCursorOffset,
    onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => {
      void submit(value, { isSlashPick: isSubmittingSlashCommand === true })
    },
    onModeChange: setMode,
    markAccepted: suggestionApi.markAccepted,
  })

  const recallFitsOneRow = useCallback(
    (value: string): boolean => {
      if (value.includes('\n')) return false
      return stringWidth(value) <= Math.max(1, (isCompact ? compactBudget?.inputColumns ?? columns : columns - 3) - 1)
    },
    [columns, isCompact, compactBudget?.inputColumns],
  )
  const applyRecalledEntry = useCallback(
    (value: string, recalledMode: PromptInputMode, recalledPastes: Record<number, PastedContent>): void => {
      onChange(value)
      setMode(recalledMode)
      pendingInput.setPastedContents(recalledPastes)
    },
    [onChange, setMode],
  )
  const history = useArrowKeyHistory(
    applyRecalledEntry,
    input,
    pastedContents,
    setCursorOffset,
    mode,
    recallFitsOneRow,
  )
  historyRecallActiveRef.current = history.historyIndex !== 0
  const recallQueuedSend = useCallback((): boolean => {
    const focused = getFocusedSessionConnector()
    const queued = focused.recallableSend()
    if (queued === null) return false
    void focused.withdrawSend(queued.clientMessageId).then(receipt => {
      if (receipt.withdrawn) {
        const meanwhile = pendingInput.text()
        const value = meanwhile === '' ? receipt.text : `${receipt.text}${meanwhile}`
        applyRecalledEntry(value, receipt.mode, receipt.pastedContents)
        setCursorOffset(value.length)
        return
      }
      addNotification({ key: 'recall-send', text: receipt.detail, priority: 'immediate', timeoutMs: receipt.retired === true ? LOST_LINE_NOTICE_MS : 4000 })
    })
    return true
  }, [applyRecalledEntry, setCursorOffset, addNotification])

  const helpers: PromptInputHelpers = useMemo(
    () => ({
      setCursorOffset,
      clearBuffer: buffer.clearBuffer,
      resetHistory: history.resetHistory,
    }),
    [setCursorOffset, buffer.clearBuffer, history.resetHistory],
  )

  const historySearch = useHistorySearch(
    entry => {
      const display = entry.display
      pendingInput.setPastedContents(entry.pastedContents ?? {})
      void submit(display, {})
    },
    input,
    (value: string) => {
      writeDraft(value)
    },
    setCursorOffset,
    cursorOffset,
    setMode,
    mode,
    isSearchingHistory,
    setIsSearchingHistory,
    (next: Record<number, PastedContent>) => pendingInput.setPastedContents(next),
    pastedContents,
  )

  const historyNavAllowed = (edge: 'first' | 'last'): boolean => {
    if (suggestionsMirrorRef.current.suggestions.length > 1) return false
    const firstNewline = input.indexOf('\n')
    if (firstNewline === -1) return true
    if (edge === 'first') return cursorOffset <= firstNewline
    return cursorOffset > input.lastIndexOf('\n')
  }
  const submit = useComposerSubmit({
    compactWork,
    appStateStore,
    suggestionApi,
    crewContext,
    commands,
    helpers,
    buffer,
    history,
    onSubmit,
    onAgentSubmit,
    setAppState,
    setCursorOffset,
    addNotification,
    removeNotification,
    composerCrewmateRef,
    suggestionsMirrorRef,
    writeDraft,
  })

  const helmVersion = useSyncExternalStore(
    subscribeHelmFocus,
    getHelmVersion,
    getHelmVersion,
  )
  const routeVersion = useSyncExternalStore(
    subscribeSurfaceRoute,
    surfaceRouteVersion,
    surfaceRouteVersion,
  )
  void routeVersion
  const surfaceCovered = currentSurfaceRoute().kind !== 'repl'
  const submitRef = useRef(submit)
  submitRef.current = submit
  useEffect(() => {
    const activation = consumeHelmActivation()
    const dispatch = consumeCommandDispatch()
    const prefill = consumePromptPrefill()
    if (activation !== null) {
      switch (activation.type) {
        case 'crewmate':
          enterCrewmateView(activation.id, setAppState)
          setHelmFocus('prompt')
          break
        case 'main':
          exitCrewmateView(setAppState)
          setHelmFocus('prompt')
          break
        case 'command':
          setHelmFocus('prompt')
          void submitRef.current(activation.command, { fromKeybinding: true })
          break
        case 'files':
          setHelmFocus('prompt')
          openFilesMenu()
          break
        case 'console':
          setHelmFocus('telemetry')
          beginConsoleCompose()
          break
      }
    }
    if (dispatch !== null) {
      void submitRef.current(dispatch, { fromKeybinding: true })
    }
    if (prefill !== null) {
      setHelmFocus('prompt')
      insertAtCursor(prefill)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the version counter by design
  }, [helmVersion])

  const { performUndo, crewmateFooterIndex } = useComposerKeybindings({
    buffer,
    input,
    cursorOffset,
    pastedContents,
    writeDraft,
    lastSelfWriteRef,
    setCursorOffset,
    addNotification,
    setExternalEditorActive,
    setOverlay,
    setHelpOpen,
    helpOpen,
    modalOverlayUp,
    isSearchingHistory,
    isLoading,
    speculationActive,
    onMessageActionsEnter,
    appStateStore,
    setAppState,
    toolPermissionContext,
    setToolPermissionContext,
    crewContext,
    footerSelection,
    insertAtCursor,
    handleImagePaste,
    handleImageError,
    setShowCommandPalette,
    setShowFileOpen,
    setShowContentSearch,
  })

  useComposerRawKeys({
    modalOverlayUp,
    compactWork,
    input,
    cursorOffset,
    mode,
    footerSelection,
    helpOpen,
    isSearchingHistory,
    messages,
    isLoading,
    speculationActive,
    appStateStore,
    engineModel,
    cockpitActive,
    voicePhase: voice.phase,
    getToolUseContext,
    insertAtCursor,
    setMode,
    setHelpOpen,
    setCursorOffset,
    setAppState,
    addNotification,
    onShowMessageSelector,
    submitRef,
    suggestionsMirrorRef,
    viewedCrewmateRef,
  })


  const displayedValue = isSearchingHistory
    ? (historySearch.historyMatch?.display ?? input)
    : input
  const highlights = useMemo((): TextHighlight[] => {
    const spans: TextHighlight[] = []
    if (isSearchingHistory && historySearch.historyMatch !== undefined && !historySearch.historyFailedMatch) {
      spans.push({
        start: 0,
        end: Math.min(historySearch.historyQuery.length, displayedValue.length),
        color: 'permission',
        priority: 20,
      })
    }
    for (const ref of parseReferences(displayedValue)) {
      if (ref.index === cursorOffset) {
        spans.push({
          start: ref.index,
          end: ref.index + ref.match.length,
          inverse: true,
          priority: 8,
        })
      }
    }
    for (const position of findSlashCommandPositions(displayedValue)) {
      const bare = displayedValue.slice(position.start + 1, position.end)
      if (commands.some(command => command.name === bare || command.aliases?.includes(bare) === true)) {
        spans.push({ start: position.start, end: position.end, color: 'suggestion', priority: 5 })
      }
    }
    for (const position of findTokenBudgetPositions(displayedValue)) {
      spans.push({ start: position.start, end: position.end, color: 'suggestion', priority: 5 })
    }
    if (mcpClients.some(client => client.name.toLowerCase().includes('slack'))) {
      for (const position of findSlackChannelPositions(displayedValue)) {
        spans.push({ start: position.start, end: position.end, color: 'suggestion', priority: 5 })
      }
    }
    if (isCrewEnabled() && crewContext !== undefined) {
      const memberPattern = /(^|\s)@([\w-]+)/g
      for (const match of displayedValue.matchAll(memberPattern)) {
        const name = match[2] as string
        const member = Object.values(crewContext.crewmates).find(entry => entry.name === name)
        const mapped = member?.color !== undefined
          ? (AGENT_COLOR_TO_THEME_COLOR as Record<string, keyof Theme>)[member.color]
          : undefined
        if (mapped !== undefined) {
          const start = (match.index ?? 0) + (match[1] as string).length
          spans.push({ start, end: start + 1 + name.length, color: mapped, priority: 5 })
        }
      }
    }
    return spans
  }, [displayedValue, isSearchingHistory, historySearch.historyMatch, historySearch.historyFailedMatch, historySearch.historyQuery, cursorOffset, commands, mcpClients, crewContext])

  const effortText = composerEffortNotice({
    model: focusedEffectiveModel !== '' ? focusedEffectiveModel : (engineModel ?? focusedMainModel),
    seatEffort,
    sentEffort,
    effortValue,
    bornEffort,
  })
  const effortBaselineRef = useRef<{ armed: boolean; text: string | undefined }>({
    armed: false,
    text: undefined,
  })
  useEffect(() => {
    const baseline = effortBaselineRef.current
    if (!baseline.armed) {
      effortBaselineRef.current = { armed: true, text: effortText }
      return
    }
    if (effortText === baseline.text) return
    effortBaselineRef.current = { armed: true, text: effortText }
    if (effortText === undefined) {
      removeNotification('effort-level')
      return
    }
    addNotification({
      key: 'effort-level',
      text: effortText,
      priority: 'high',
      timeoutMs: 12000,
      fold: (_accumulator, incoming) => incoming,
    })
  }, [effortText, addNotification, removeNotification])

  const placeholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName: viewedAgentName,
    cockpitActive,
    compact: isCompact,
  })
  const banner = useCrewBanner()
  const borderStyle = isCompact ? compactBudget?.composerBorderRows === 2 ? 'round' : undefined : composerBorderStyle(rows)
  const nonDefaultModeColor = !isDefaultMode(toolPermissionContext.mode)
    ? ('permission' as keyof Theme)
    : undefined
  const borderColor: keyof Theme =
    mode === 'bash'
      ? 'bashBorder'
      : (nonDefaultModeColor ?? composerBorderRole(input === ''))

  const compactPool = compactBudget?.editorPoolRows ?? rows
  const compactTransientRows = isCompact ? Math.min(2, Math.max(0, compactPool - 1)) : 0
  const compactSuggestionRows = isCompact && typeahead.suggestions.length > 0 ? Math.min(5, Math.max(0, compactPool - compactTransientRows - 1)) : 0
  const maxVisibleLines = isCompact
    ? Math.max(1, Math.min(Math.max(1, Math.floor(rows / 2) - 5), compactPool - compactTransientRows - compactSuggestionRows))
    : fullscreen ? Math.max(3, Math.floor(rows / 2) - 5) : undefined

  const textColumns = isCompact ? Math.max(1, compactBudget?.inputColumns ?? columns) : columns - 3
  const composerViewportStartRef = useRef<number | undefined>(undefined)
  const { ownSelection, handleInputBoxClick, handleInputTextGesture } = useComposerSelectionRoad(selection, {
    input,
    cursorOffset,
    textColumns,
    maxVisibleLines,
    composerViewportStartRef,
    isSearchingHistory,
    setCursorOffset,
  })
  const pushAtomic = buffer.pushAtomic

  const exitStateChange = useCallback((show: boolean, keyName?: string): void => {
    setExitState({ pending: show, keyName: keyName ?? null })
  }, [])

  const voiceInputFilter = useCallback((rawInput: string, key: Key): string => holdToTalkKey(rawInput, key), [])
  useEffect(() => {
    setHoldToTalkEditor({
      text: () => pendingInput.text(),
      cursor: () => cursorRef.current,
      splice: (deleteBefore, insert) => {
        const text = pendingInput.text()
        const at = Math.max(0, Math.min(cursorRef.current, text.length))
        const from = Math.max(0, at - deleteBefore)
        const next = text.slice(0, from) + insert + text.slice(at)
        writeDraft(next)
        setCursorOffset(from + insert.length)
      },
    })
    return () => setHoldToTalkEditor(null)
  }, [setCursorOffset])
  if (externalEditorActive) {
    return (
      <Box
        borderStyle={borderStyle}
        borderColor={borderColor as string}
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        justifyContent="center"
      >
        <Text dimColor italic>
          editing in your external editor — save and close to continue
        </Text>
      </Box>
    )
  }
  if (overlay === 'tasks-dialog') {
    return (
      <BackgroundTasksDialog
        onDone={() => setOverlay(null)}
        toolUseContext={getToolUseContext(messages, [], new AbortController(), engineModel ?? '')}
      />
    )
  }
  if (showCommandPalette) {
    return (
      <MercuryCommandPalette
        commands={commands}
        actions={[
          {
            kind: 'open', action: 'app:fileOpen', context: 'Global',
            label: 'open a file',
            run: () => { setShowCommandPalette(false); setShowFileOpen(true) },
          },
          {
            label: 'search file contents',
            run: () => { setShowCommandPalette(false); setShowContentSearch(true) },
            kind: 'open', action: 'app:contentSearch', context: 'Global',
          },
          {
            label: 'reverse history search',
            kind: 'open',
            run: () => {
              setShowCommandPalette(false)
              historySearch.handleStartSearch()
            },
          },
          {
            label: 'open the model picker',
            kind: 'open',
            action: 'chat:modelPicker',
            context: 'Chat',
            run: () => {
              setShowCommandPalette(false)
              setOverlay('model-picker')
            },
          },
        ]}
        onRun={text => {
          setShowCommandPalette(false)
          insertAtomic(text)
        }}
        onClose={() => setShowCommandPalette(false)}
      />
    )
  }
  if (showFileOpen) {
    return (
      <MercuryFileOpen
        onPick={text => {
          setShowFileOpen(false)
          insertAtomic(text)
        }}
        onClose={() => setShowFileOpen(false)}
      />
    )
  }
  if (showContentSearch) {
    return (
      <MercuryContentSearch
        onPick={text => {
          setShowContentSearch(false)
          insertAtomic(text)
        }}
        onClose={() => setShowContentSearch(false)}
      />
    )
  }
  if (doors.surface !== null) return doors.surface
  if (overlay === 'thinking-toggle') {
    return (
      <ThinkingToggle
        currentValue={(appStateStore.getState().thinkingEnabled ?? true) === true}
        isMidConversation={messages.some(message => message.type === 'assistant')}
        onSelect={next => {
          setAppState(prev => ({ ...prev, thinkingEnabled: next }))
          setOverlay(null)
          addNotification({
            key: 'thinking-toggled-hotkey',
            text: `Thinking ${next ? 'on' : 'off'}`,
            color: next ? 'suggestion' : 'subtle',
            priority: 'high',
            timeoutMs: 3000,
          })
        }}
        onCancel={() => setOverlay(null)}
      />
    )
  }

  const searchField = isSearchingHistory ? (
    <HistorySearchInput
      value={historySearch.historyQuery}
      onChange={historySearch.setHistoryQuery}
      historyFailedMatch={historySearch.historyFailedMatch}
    />
  ) : undefined
  const helmOnPrompt = getHelmFocus() === 'prompt'
  const keyboardOwnedByOverlay =
    overlay !== null ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive ||
    popupUp
  const inputAvailable = footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered && !keyboardOwnedByOverlay
  const inputFocused = inputAvailable && compactFocus === 'composer'
  const showCursor =
    footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered && !keyboardOwnedByOverlay && compactFocus === 'composer'
  const vimEnabled = isVimModeEnabled()

  const textInputProps = {
    viewportStartRef: composerViewportStartRef,
    value: input,
    onChange,
    cursorOffset,
    onChangeCursorOffset: (offset: number) => {
      const shift = deferredSpaceShiftRef.current
      deferredSpaceShiftRef.current = 0
      setCursorOffset(offset + shift)
    },
    columns: textColumns,
    pastePendingRef,
    routeInput: compactWork === undefined ? undefined : (raw: string, key: Key, event: import('../../ink/events/input-event.js').InputEvent, pastePending: boolean) => {
      if (currentSurfaceRoute().kind !== 'repl') return 'yield' as const
      const focus = compactWork.read()
      if (anyModalOverlayActive() && !(focus === 'composer' && topOverlay()?.id === 'compact-work')) return 'yield' as const
      if (keyboardOwnedByOverlay || isSearchingHistory || !helmOnPrompt) return 'yield' as const
      if (focus === 'detail') {
        if (key.escape) compactWork.set('composer')
        return 'consume' as const
      }
      if (pastePending) {
        const resolved = keybindings?.resolve(raw, key, ['Chat', 'Global'])
        return resolved?.type === 'match' && resolved.action === 'app:toggleTasks' ? 'consume' as const : 'edit-and-consume' as const
      }
      const resolved = keybindings?.resolve(raw, key, ['Footer', 'Chat', 'Global'])
      if (isCompact && resolved?.type === 'match' && resolved.action === 'app:toggleTasks') {
        compactWork.toggleSummary()
        return 'consume' as const
      }
      if (focus !== 'summary') return inputAvailable ? 'edit' as const : 'yield' as const
      if (!summaryVisible) { compactWork.set('composer'); return 'edit' as const }
      if (key.isPasted || (raw !== '' && !key.ctrl && !key.meta && !key.escape && !key.return && !key.tab && !key.upArrow && !key.downArrow && !key.leftArrow && !key.rightArrow && !key.pageUp && !key.pageDown && !key.backspace && !key.delete)) {
        compactWork.set('composer')
        return 'edit-and-consume' as const
      }
      if (key.escape) { compactWork.set('composer'); return 'consume' as const }
      if (key.return && !key.shift && !key.ctrl && !key.meta) { compactWork.set('detail'); return 'consume' as const }
      if (key.pageUp || key.pageDown || key.wheelUp || key.wheelDown) return 'yield' as const
      if (key.ctrl && (raw === 'c' || raw === 'd')) { compactWork.set('composer'); return 'edit' as const }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) { compactWork.set('composer'); return 'consume' as const }
      void event
      return 'consume' as const
    },
    inputFilter: voiceInputFilter,
    onSubmit: (value: string) => {
      void submit(value, {})
    },
    onExit,
    onExitMessage: exitStateChange,
    onHistoryUp: () => {
      if (!historyNavAllowed('first')) return
      if (input === '' && recallQueuedSend()) return
      history.onHistoryUp()
    },
    onHistoryDown: () => {
      if (!historyNavAllowed('last')) return
      if (history.historyIndex === 0) {
        if (footerSelection === null && suggestionsMirrorRef.current.suggestions.length === 0) {
          const manageable = Object.values(appStateStore.getState().tasks).filter(isManageableTask)
          if (!isCompact && manageable.length > 0) {
            setAppState(prev => ({ ...prev, footerSelection: 'tasks' as const }))
            if (getGlobalConfig().hasSeenTasksHint !== true) {
              saveGlobalConfig(config => ({ ...config, hasSeenTasksHint: true }))
            }
          }
        }
        return
      }
      history.onHistoryDown()
    },
    onHistoryReset: history.resetHistory,
    onPaste: handleTextPaste,
    onImagePaste: handleImagePaste,
    onImageError: handleImageError,
    onIsPastingChange: setIsPasting,
    focus: inputFocused,
    showCursor,
    multiline: true,
    placeholder:
      suggestionApi.suggestion !== null && mode === 'prompt' && !viewedAgentName
        ? suggestionApi.suggestion
        : placeholder,
    highlights,
    userTextColor: composerBloom,
    disableCursorMovementForUpDownKeys:
      footerSelection !== null || suggestionsMirrorRef.current.suggestions.length > 0,
    suppressEnterSubmit:
      typeahead.suggestions.length > 0 &&
      (typeahead.suggestionType === 'command' ||
        typeahead.suggestionType === 'custom-title'),
    maxVisibleLines,
    argumentHint: typeahead.commandArgumentHint,
    inlineGhostText: typeahead.inlineGhostText,
    onUndo: performUndo,
  }

  const inputBody = (
    <Box flexDirection="row" maxHeight={isCompact ? maxVisibleLines : undefined} overflow={isCompact ? "hidden" : undefined}>
      <PromptInputModeIndicator
        cells={isCompact ? compactBudget?.inputPrefixColumns : undefined}
        mode={mode}
        isLoading={isLoading}
        inputEmpty={input === ''}
        viewedAgentName={viewedAgentName}
        viewedAgentColor={viewedAgentColor}
      />
      <Box
        flexGrow={1}
        minWidth={0}
        ref={inputBoxRef}
        onClick={handleInputBoxClick}
        onTextGesture={handleInputTextGesture}
      >
        {vimEnabled ? (
          <VimTextInput
            {...textInputProps}
            initialMode={vimMode}
            onModeChange={setVimMode}
          />
        ) : (
          <TextInput
            {...textInputProps}
            selectionRange={() => inputSelectionRangeRef.current()}
            selectionHighlight={ownSelection}
            onSelectionConsumed={() => {
              clearOwnSelection()
              selectionApi.clearSelection()
            }}
            onBeforeRangeEdit={() => pushAtomic(input, cursorOffset, pastedContents)}
          />
        )}
      </Box>
    </Box>
  )

  const bannerLabel = banner !== null ? truncateToWidth(banner.text, Math.max(0, columns - 6)) : null
  const frame =
    !isCompact && banner !== null && bannerLabel !== null ? (
      <Box flexDirection="column">
        <Text color={banner.bgColor}>
          {'-'.repeat(Math.max(0, columns - stringWidth(bannerLabel) - 4))}
          <Text backgroundColor={banner.bgColor}> {bannerLabel} </Text>
          {'--'}
        </Text>
        {inputBody}
        <Text color={banner.bgColor}>{'-'.repeat(Math.max(1, columns))}</Text>
      </Box>
    ) : (
      <Box
        flexDirection="column"
        borderStyle={borderStyle}
        borderColor={theme[borderColor] as string}
        borderDimColor={input === ''}
      >
        {inputBody}
      </Box>
    )


  return (
    <Box flexDirection="column">
      <Box flexDirection="column" maxHeight={isCompact ? Math.ceil(compactTransientRows / 2) : undefined} overflow="hidden">
      <IssueFlagBanner />
      {capLaneLine !== null ? (
        capLaneCut !== null ? (
          <Box paddingLeft={1}>
            <Box width={capLaneCut.bodyColumns} flexShrink={0} minWidth={0}>
              <Text color={AMBER} wrap="truncate-end">{capLaneCut.body}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={AMBER}>{capLaneCut.tail}</Text>
            </Box>
          </Box>
        ) : (
          <Box paddingLeft={1}>
            <Text color={AMBER}>{capLaneLine}</Text>
          </Box>
        )
      ) : null}
      {hasSuppressedDialogs ? (
        <Box marginTop={isCompact ? 0 : 1} marginLeft={isCompact ? 0 : 2}>
          <Text dimColor wrap="truncate-end">Waiting for permission…</Text>
        </Box>
      ) : null}
      </Box>
      {frame}
      {summaryVisible && compactWork !== undefined ? <CompactWorkSummary columns={columns} focused={compactFocus === 'summary'} vimInsert={vimEnabled && vimMode === 'INSERT'} onFocus={() => { if (canFocusSummary()) compactWork.set('summary') }} /> : null}
      {!isCompact ? <PromptInputStashNotice hasStash={stash !== undefined} /> : null}
      {fullscreen ? (
        <Box maxHeight={isCompact ? Math.floor(compactTransientRows / 2) : undefined} overflow="hidden">
          <Notifications
            compact={isCompact}
            apiKeyStatus={apiKeyStatus}
            debug={debug}
            verbose={verbose}
            messages={messages}
            mcpClients={mcpClients}
            isInputWrapped={input.includes('\n')}
            alignStart
          />
        </Box>
      ) : null}
      <PromptInputFooter
        compact={isCompact}
        maxRows={isCompact ? (helpOpen ? Math.max(2, (compactBudget?.editorPoolRows ?? 2) - 1) : compactBudget?.noticeRows ?? 0) : undefined}
        suggestionRows={isCompact ? compactSuggestionRows : undefined}
        suggestions={typeahead.suggestions}
        selectedSuggestion={getSelectedSuggestion()}
        suggestionType={typeahead.suggestionType}
        onSuggestionPick={typeahead.acceptSuggestionAt}
        onSuggestionHover={typeahead.hoverSuggestionAt}
        helpOpen={helpOpen}
        input={input}
        mode={mode}
        isLoading={isLoading}
        exitPending={exitState.pending}
        exitKeyName={exitState.keyName}
        isPasting={isPasting}
        searchField={searchField}
        isSearching={isSearchingHistory}
        vimInsert={vimEnabled && vimMode === 'INSERT'}
        apiKeyStatus={apiKeyStatus}
        debug={debug}
        verbose={verbose}
        messages={messages}
        mcpClients={mcpClients}
        crewmateFooterIndex={crewmateFooterIndex}
        onOpenTasksDialog={() => setOverlay('tasks-dialog')}
      />
    </Box>
  )
}

const PromptInput = React.memo(PromptInputInner)
export default PromptInput
