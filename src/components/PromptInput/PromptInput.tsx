
import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box } from '../../ink.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useNotifications } from '../../context/notifications.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import { useTypeahead } from '../../hooks/useTypeahead.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { useAppState, useAppStateStore, useSetAppState, type AppState } from '../../state/AppState.js'
import type { PastedContent } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import type { VimMode } from '../../types/textInputTypes.js'
import {
  getHelmFocus,
} from '../../utils/cockpit/helmFocus.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'
import { useCrewBanner } from './useCrewBanner.js'
import { isVimModeEnabled } from './utils.js'
import HistorySearchInput from './HistorySearchInput.js'
import { PromptInputFooter } from './PromptInputFooter.js'
import { PromptInputModeIndicator } from './PromptInputModeIndicator.js'
import { PromptInputStashNotice } from './PromptInputStashNotice.js'
import { Notifications } from './Notifications.js'
import TextInput from '../TextInput.js'
import VimTextInput from '../VimTextInput.js'
import type { OverlaySurface } from './composerOverlay.js'
import { useComposerModelDoors } from './useComposerModelDoors.js'
import { useComposerSubmit } from './useComposerSubmit.js'
import { useComposerRawKeys } from './useComposerRawKeys.js'
import { useComposerAttachments } from './useComposerAttachments.js'
import { useComposerKeybindings } from './useComposerKeybindings.js'
import { useComposerSelectionRoad, useComposerSelectionState } from './useComposerSelection.js'
import { useComposerDraft } from './useComposerDraft.js'
import { useComposerHoldToTalk, useComposerVoiceReceipt } from './useComposerVoice.js'
import { useComposerSuggestions } from './useComposerSuggestions.js'
import { useComposerCrewmateRefs } from './useComposerCrewmateRefs.js'
import { useComposerCompactFocus } from './useComposerCompactFocus.js'
import { useComposerHistory } from './useComposerHistory.js'
import { useComposerHelm } from './useComposerHelm.js'
import { useComposerHighlights } from './useComposerHighlights.js'
import { useComposerEffortNotice } from './useComposerEffortNotice.js'
import { composerSurface } from './composerSurface.js'
import { composerHistoryDown, composerRouteInput } from './composerRouteInput.js'
import { composerFrame, composerGeometry, composerNotices } from './composerFrame.js'
import { getTheme } from '../../utils/theme.js'
import { useFocusedTranscript } from '../../hooks/useFocusedTranscript.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { useFocusedBornEffort, useFocusedSentEffort, useFocusedServedEffort } from '../../hooks/useDisplayedSessionModel.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { CompactFrameBudgetContext, useLayoutChrome } from '../../context/layoutChromeContext.js'
import { CompactWorkSummary, type CompactWorkControls, type CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { popupOwnsKeys, subscribePopupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { fluxMark, fluxWhy } from '../../utils/flux/fluxProbe.js'

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
  const voice = useComposerVoiceReceipt(addNotification)
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

  const canFocusSummary = useComposerCompactFocus({
    compactWork,
    summaryVisible,
    modalOverlayUp,
    externalEditorActive,
    isSearchingHistory,
    helpOpen,
    exitState,
    pastePendingRef,
    isCompact,
    footerSelection,
    setAppState,
  })

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

  const { composerCrewmateRef, viewedCrewmateRef, commandCrewmateRef, viewedAgentName, viewedAgentColor } = useComposerCrewmateRefs(viewedTask)


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
    readLiveState: draft.readLiveState,
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

  const { suggestionsState, setSuggestionsState, suggestionsMirrorRef } = useComposerSuggestions()

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

  const { history, recallQueuedSend, helpers } = useComposerHistory({
    input,
    pastedContents,
    mode,
    onChange,
    setMode,
    setCursorOffset,
    buffer,
    columns,
    isCompact,
    compactBudget,
    historyRecallActiveRef,
    addNotification,
  })

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
    commandCrewmateRef,
    suggestionsMirrorRef,
    writeDraft,
  })

  const { surfaceCovered, submitRef } = useComposerHelm({ submit, setAppState })

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
    footerSelection,
    insertAtCursor,
    handleImagePaste,
    handleImageError,
    setShowCommandPalette,
    setShowFileOpen,
    setShowContentSearch,
    commandCrewmateRef,
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


  const highlights = useComposerHighlights({
    isSearchingHistory,
    historySearch,
    input,
    cursorOffset,
    commands,
    mcpClients,
  })

  useComposerEffortNotice({
    focusedEffectiveModel,
    engineModel,
    focusedMainModel,
    seatEffort,
    sentEffort,
    effortValue,
    bornEffort,
    addNotification,
    removeNotification,
  })

  const placeholder = usePromptInputPlaceholder({
    input,
    submitCount,
    viewingAgentName: viewedAgentName,
    cockpitActive,
    compact: isCompact,
  })
  const banner = useCrewBanner()
  const { borderStyle, borderColor, compactTransientRows, compactSuggestionRows, maxVisibleLines, textColumns } = composerGeometry({
    isCompact,
    compactBudget,
    rows,
    columns,
    toolPermissionContext,
    mode,
    input,
    typeahead,
    fullscreen,
  })
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

  const voiceInputFilter = useComposerHoldToTalk({ cursorRef, writeDraft, setCursorOffset })
  const surface = composerSurface({
    externalEditorActive,
    borderStyle,
    borderColor,
    overlay,
    setOverlay,
    getToolUseContext,
    messages,
    engineModel,
    showCommandPalette,
    setShowCommandPalette,
    showFileOpen,
    setShowFileOpen,
    showContentSearch,
    setShowContentSearch,
    commands,
    historySearch,
    commandCrewmateRef,
    setAppState,
    addNotification,
    insertAtomic,
    doors,
    appStateStore,
  })
  if (surface !== null) return surface

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
    routeInput: composerRouteInput({
      compactWork,
      keyboardOwnedByOverlay,
      isSearchingHistory,
      helmOnPrompt,
      keybindings,
      isCompact,
      inputAvailable,
      summaryVisible,
    }),
    inputFilter: voiceInputFilter,
    onSubmit: (value: string) => {
      void submit(pendingInput.text() || value, {})
    },
    onClearInput: () => {
      setMode('prompt')
      setHelpOpen(false)
    },
    onExit,
    onEscape: history.historyIndex === 0 ? undefined : () => {
      onChange('')
      setCursorOffset(0)
      setMode('prompt')
      setHelpOpen(false)
      history.resetHistory()
    },
    onExitMessage: exitStateChange,
    onHistoryUp: () => {
      if (!historyNavAllowed('first')) return
      if (input === '' && recallQueuedSend()) return
      history.onHistoryUp()
    },
    onHistoryDown: composerHistoryDown({
      historyNavAllowed,
      history,
      footerSelection,
      suggestionsMirrorRef,
      isCompact,
      compactWork,
      canFocusSummary,
      appStateStore,
      setAppState,
    }),
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
        typeahead.suggestionType === 'custom-title' ||
        typeahead.suggestionType === 'channel-target'),
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

  const frame = composerFrame({ banner, columns, isCompact, inputBody, borderStyle, theme, borderColor, input })


  return (
    <Box flexDirection="column">
      {composerNotices({ isCompact, compactTransientRows, capLaneLine, capLaneCut, hasSuppressedDialogs })}
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
