
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
import { Box, Text, useInput } from '../../ink.js'
import type { DOMElement } from '../../ink/dom.js'
import { nodeCache, type CachedLayout } from '../../ink/node-cache.js'
import { useSelection } from '../../ink/hooks/use-selection.js'
import { Cursor } from '../../utils/Cursor.js'
import {
  noteOwnInputSelectionChanged,
  noteOwnInputSelectionSettled,
  registerInputSelectionOwner,
} from '../../utils/cockpit/inputSelectionBridge.js'
import type { TextGesture } from '../../ink/events/text-gesture.js'
import { getFocusedSessionConnector, subscribeThroughFocused } from '../../services/engine-connector/focusedConnector.js'
import type { Command } from '../../commands.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useNotifications } from '../../context/notifications.js'
import { useSetPromptOverlayDialog } from '../../context/promptOverlayContext.js'
import {
  currentSurfaceRoute,
  isPriorGenerationInput,
  subscribeSurfaceRoute,
  surfaceRouteVersion,
} from '../../context/surfaceRoute.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useArrowKeyHistory } from '../../hooks/useArrowKeyHistory.js'
import { useHistorySearch } from '../../hooks/useHistorySearch.js'
import { useInputBuffer } from '../../hooks/useInputBuffer.js'
import { usePromptSuggestion } from '../../hooks/usePromptSuggestion.js'
import { useDoublePress } from '../../hooks/useDoublePress.js'
import { useTypeahead, type SuggestionsState } from '../../hooks/useTypeahead.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { holdToTalkKey, setHoldToTalkEditor } from '../../services/voice/holdToTalk.js'
import { cancelVoiceCapture, subscribeVoice, voiceSnapshot } from '../../services/voice/voiceSession.js'
import { useAppState, useAppStateStore, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  clearMainChat,
  enterCrewmateView,
  exitCrewmateView,
  setMainChat,
} from '../../state/crewmateViewHelpers.js'
import { composerTargetTaskId } from '../../state/selectors.js'
import { useComposerCrewmate, useViewedCrewmate } from '../tasks/useCrewmateView.js'
import { CREWMATE_BETWEEN_TURNS_DETAIL, crewClearedWords, crewClearRefusedWords, crewmateEscBackWords, crewmateInterruptedWords, crewmateInterruptRefusedWords, crewmateQueuedWords, crewmateRefusedWords, crewmateResumedWords, operatorLinePlate } from '../../utils/cockpit/crewmateWords.js'
import { crewStateLabel } from '../../services/engine-connector/crewFacts.js'
import { clearCrewmate } from '../../state/crewLedger.js'
import { interruptCrewmate } from '../tasks/crewmateInterrupt.js'
import { queueCrewmateLine, refuseCrewmateLine } from '../tasks/crewmateQueue.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import type { PastedContent } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import type { VimMode } from '../../types/textInputTypes.js'
import {
  consumeCommandDispatch,
  consumeHelmActivation,
  consumePromptPrefill,
  currentHelmRow,
  cycleHelmFocus,
  getHelmCursor,
  getHelmFocus,
  getHelmVersion,
  helmRailPastEntryBuffer,
  moveHelmCursor,
  nextHelmPane,
  requestHelmRowActivation,
  setHelmFocus,
  setPromptEmpty,
  subscribeHelmFocus,
} from '../../utils/cockpit/helmFocus.js'
import {
  beginConsoleCompose,
  consoleAbortAsk,
  consoleBackspace,
  consoleClear,
  consoleCursorEnd,
  consoleCursorHome,
  consoleDeleteForward,
  consoleEnabled,
  consoleHistoryMove,
  consoleInsert,
  consoleKillLine,
  consoleKillWord,
  consoleMoveCursor,
  consoleSubmitBuffer,
  exitConsoleCompose,
  getConsoleBuffer,
  isConsoleComposing,
} from '../../utils/cockpit/helmConsole.js'
import { runConsoleAsk } from '../../utils/cockpit/helmConsoleAsk.js'
import { classifyAgentViewSubmission } from './promptIntent.js'
import { getModeFromInput, getValueFromInput } from './inputModes.js'
import { normalizePastedInput } from '../../input-core/composer-document.js'
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js'
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
import { setComposerInsert } from './composerInsert.js'
import type { OverlaySurface } from './composerOverlay.js'
import { useComposerModelDoors } from './useComposerModelDoors.js'
import { MercuryContentSearch } from '../MercuryContentSearch.js'
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { isInProcessCrewmateTask } from '../../tasks/InProcessCrewmateTask/types.js'
import { injectUserMessageToCrewmate } from '../../tasks/InProcessCrewmateTask/InProcessCrewmateTask.js'
import { appendMessageToLocalAgent, isLocalAgentTask, queueOperatorMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getViewedCrewmateTask } from '../../state/selectors.js'
import { sendLiveMessage } from '../../services/crew/liveComms.js'
import { isCrewEnabled } from '../../utils/crewEnabled.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useFocusedTranscript } from '../../hooks/useFocusedTranscript.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js'
import { findSlackChannelPositions } from '../../utils/suggestions/slackChannelSuggestions.js'
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { danglingReferences, getPastedTextRefNumLines, formatPastedTextRef, formatImageRef, parseReferences, pasteUnavailableLine } from '../../history.js'
import { PASTE_THRESHOLD, getImageFromClipboard } from '../../utils/imagePaste.js'
import { describeAttachedImage } from '../../utils/imageResizer.js'
import { cacheImagePath, storeImage } from '../../utils/imageStore.js'
import { editPromptInEditor } from '../../utils/promptEditor.js'
import { expandPastedTextRefs } from '../../history.js'
import { hashPastedText, storePastedText } from '../../utils/pasteStore.js'
import {
  cyclePermissionMode,
  getNextPermissionMode,
} from '../../utils/permissions/getNextPermissionMode.js'
import { syncCrewmateMode } from '../../utils/crew/crewHelpers.js'
import { parseDirectMemberMessage, sendDirectMemberMessage } from '../../utils/directMemberMessage.js'
import { getEffortNotificationText } from '../EffortIndicator.js'
import { isDefaultMode } from '../../utils/permissions/PermissionMode.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { CompactFrameBudgetContext, useLayoutChrome } from '../../context/layoutChromeContext.js'
import { CompactWorkSummary, type CompactWorkControls, type CompactWorkFocus } from '../tasks/CompactWorkSummary.js'
import { useOptionalKeybindingContext } from '../../keybindings/KeybindingContext.js'
import { anyModalOverlayActive, topOverlay } from '../../context/overlayStack.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { abortSpeculation, handleSpeculationAccept } from '../../services/PromptSuggestion/speculation.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import { composerBorderRole, composerBorderStyle } from '../mercury-ui/composerFloor.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getPlatform } from '../../utils/platform.js'
import { openFilesMenu } from '../../utils/cockpit/filesMenu.js'
import { popupOwnsKeys, subscribePopupOwnsKeys } from '../../utils/cockpit/popupOwnsKeys.js'
import { AMBER } from '../mercuryPalette.js'
import type { Key } from '../../ink/events/input-event.js'
import { stringWidth } from '../../ink/stringWidth.js'
import stripAnsi from 'strip-ansi'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { submitTrace } from '../../utils/submitTrace.js'
import { fluxMark, fluxWhy } from '../../utils/flux/fluxProbe.js'

const MANAGER_COMMAND = '/manager'
const SESSION_TAB_COMMAND = '/sessiontab'
const KEYSETUP_COMMAND = '/keysetup'
const DOUBLED_SLASH = '//'
const INPUT_TRUNCATION_THRESHOLD = 10_000
const UNDO_BUFFER_SIZE = 50
const UNDO_COALESCE_MS = 1000
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

function expandTabs(value: string): string {
  return value.includes('\t') ? value.replaceAll('\t', '    ') : value
}

function stripControls(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control filter is the point
  return stripAnsi(value.replace(/[\u0080-\u009f]/g, '')).replace(
    // eslint-disable-next-line no-control-regex -- the control filter is the point
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    '',
  )
}

export const __stripControlsForTest = stripControls

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
  void setVimMode

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

  const editGen = useSyncExternalStore(
    pendingInput.subscribePendingInput,
    pendingInput.editGeneration,
    pendingInput.editGeneration,
  )
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
  void editGen
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
  const input = pendingInput.text()
  const mode = pendingInput.mode()
  const pastedContents = pendingInput.pastedContents()
  const stash = pendingInput.stashedPrompt()

  const [cursorOffset, setCursorOffsetState] = useState(() => {
    const draft = pendingInput.readDraftFor(getFocusedSessionConnector().sessionId())
    if (
      input !== '' &&
      draft !== null &&
      draft.text === input &&
      typeof draft.cursorOffset === 'number'
    ) {
      return Math.max(0, Math.min(draft.cursorOffset, input.length))
    }
    return input.length
  })
  const setCursorOffset = useCallback((offset: number): void => {
    setCursorOffsetState(offset)
    pendingInput.reportCursor(offset)
  }, [])

  const lastSelfWriteRef = useRef(input)
  const inputSelectionRangeRef = useRef<() => { start: number; end: number } | null>(
    () => null,
  )
  const inputBoxRef = useRef<DOMElement | null>(null)
  const selectionApi = useSelection()
  const selectionGestureRectRef = useRef<CachedLayout | null>(null)
  const [, setOwnSelectionState] = useState<{ start: number; end: number; of: string } | null>(null)
  const ownSelectionRef = useRef<{ start: number; end: number; of: string } | null>(null)
  const gestureAnchorRef = useRef<{ start: number; end: number; col: number; row: number; moved: boolean } | null>(
    null,
  )
  const ownSelectionOf = (text: string): { start: number; end: number } | null => {
    const own = ownSelectionRef.current
    if (own === null || own.of !== text || own.start >= own.end) return null
    return { start: own.start, end: own.end }
  }
  const setOwnSelection = (next: { start: number; end: number; of: string } | null): void => {
    const had = ownSelectionRef.current !== null
    ownSelectionRef.current = next
    setOwnSelectionState(next)
    if (had || next !== null) noteOwnInputSelectionChanged()
  }
  const clearOwnSelection = (): void => {
    gestureAnchorRef.current = null
    if (ownSelectionRef.current === null) return
    setOwnSelection(null)
  }
  useEffect(
    () =>
      selectionApi.subscribe(() => {
        const state = selectionApi.getState()
        if (!state?.anchor) {
          selectionGestureRectRef.current = null
          return
        }
        clearOwnSelection()
        if (state.focus !== null && selectionGestureRectRef.current !== null) return
        const box = inputBoxRef.current
        selectionGestureRectRef.current = (box ? nodeCache.get(box) : undefined) ?? null
      }),
    [selectionApi],
  )
  if (lastSelfWriteRef.current !== input) {
    lastSelfWriteRef.current = input
    if (cursorOffset > input.length) {
      setCursorOffsetState(input.length)
      pendingInput.reportCursor(input.length)
    } else {
      setCursorOffsetState(input.length)
      pendingInput.reportCursor(input.length)
    }
  }

  const buffer = useInputBuffer({
    maxBufferSize: UNDO_BUFFER_SIZE,
    debounceMs: UNDO_COALESCE_MS,
  })

  const bufferSessionRef = useRef(getFocusedSessionConnector().sessionId())
  if (bufferSessionRef.current !== getFocusedSessionConnector().sessionId()) {
    bufferSessionRef.current = getFocusedSessionConnector().sessionId()
    buffer.clearBuffer();
  }

  const cursorSessionRef = useRef(getFocusedSessionConnector().sessionId())
  const cursorAtRepointRef = useRef<number | null>(null)
  useEffect(() => {
    const focusedId = getFocusedSessionConnector().sessionId()
    if (cursorSessionRef.current === focusedId) return
    if (cursorAtRepointRef.current === null) cursorAtRepointRef.current = cursorOffset
    const draft = pendingInput.readDraftFor(focusedId)
    if (draft !== null && draft.text === input && input !== '') {
      cursorSessionRef.current = focusedId
      const untouched = cursorAtRepointRef.current === cursorOffset
      cursorAtRepointRef.current = null
      if (untouched && typeof draft.cursorOffset === 'number') {
        setCursorOffset(Math.max(0, Math.min(draft.cursorOffset, input.length)))
      }
    } else if (input === '' && (draft === null || (draft.text ?? '') === '')) {
      cursorSessionRef.current = focusedId
      cursorAtRepointRef.current = null
    }
  })

  const setMode = useCallback((next: PromptInputMode): void => {
    pendingInput.setMode(next)
  }, [])
  const setPastedContents = useCallback(
    (
      next:
        | Record<number, PastedContent>
        | ((prev: Record<number, PastedContent>) => Record<number, PastedContent>),
    ): void => {
      const resolved =
        typeof next === 'function' ? next(pendingInput.pastedContents()) : next
      pendingInput.setPastedContents(resolved)
    },
    [],
  )

  const deferredSpaceArmedRef = useRef(false)
  const deferredSpaceShiftRef = useRef(0)

  const stashPeakRef = useRef(0)

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

  useEffect(() => {
    setPromptEmpty(input.trim() === '')
  }, [input])

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
  const onChange = useCallback(
    (raw: string): void => {
      if (raw === '?' && input === '') {
        setHelpOpen(!helpOpen)
        return
      }
      if (helpOpen) setHelpOpen(false)

      let value = expandTabs(stripControls(raw))

      if (deferredSpaceArmedRef.current) {
        deferredSpaceArmedRef.current = false
        if (
          cursorOffset === input.length &&
          value.length === input.length + 1 &&
          value.startsWith(input) &&
          value.slice(input.length) !== ' ' &&
          value.slice(input.length).trim() !== ''
        ) {
          value = `${input} ${value.slice(input.length)}`
          deferredSpaceShiftRef.current = 1
        }
      }

      if (mode === 'prompt') {
        if (
          value.length === input.length + 1 &&
          value.startsWith('!') &&
          value.slice(1) === input
        ) {
          pendingInput.edit(input)
          lastSelfWriteRef.current = input
          setMode('bash')
          return
        }
        if (
          input === '' &&
          value.length > 1 &&
          !value.includes('\n') &&
          getModeFromInput(value) === 'bash'
        ) {
          buffer.pushAtomic(input, cursorOffset, pastedContents)
          setMode('bash')
          const remainder = expandTabs(getValueFromInput(value))
          pendingInput.edit(remainder)
          lastSelfWriteRef.current = remainder
          setCursorOffset(remainder.length)
          return
        }
      }

      removeNotification('stash-hint')
      if (speculationActive) abortSpeculation(setAppState)
      if (footerSelection !== null) {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      }

      buffer.pushToBuffer(input, cursorOffset, pastedContents)
      pendingInput.edit(value)
      lastSelfWriteRef.current = value

      const previousLength = input.length
      stashPeakRef.current = Math.max(stashPeakRef.current, value.length)
      if (
        stashPeakRef.current >= 20 &&
        value.length <= 5 &&
        previousLength < 20 &&
        getGlobalConfig().hasUsedStash !== true
      ) {
        stashPeakRef.current = 0
        addNotification({
          key: 'stash-hint',
          text: `${getShortcutDisplay('chat:stash', 'Chat', 'ctrl+s')} stashes the draft for later`,
          priority: 'low',
          timeoutMs: 5000,
        })
      }
      if (value === '') stashPeakRef.current = 0

      const live = pendingInput.text()
      const present = new Set(parseReferences(live).map(ref => ref.id))
      {
        const prev = pendingInput.pastedContents()
        let changed = false
        const next: Record<number, PastedContent> = {}
        for (const [id, entry] of Object.entries(prev)) {
          if (present.has(Number(id))) next[Number(id)] = entry
          else changed = true
        }
        if (changed) pendingInput.setPastedContents(next)
      }
    },
    [input, mode, helpOpen, cursorOffset, pastedContents, buffer, speculationActive, footerSelection, setHelpOpen, setMode, setCursorOffset, removeNotification, addNotification, setAppState],
  )

  useMaybeTruncateInput({
    input,
    pastedContents,
    onInputChange: (value: string) => {
      pendingInput.edit(value)
      lastSelfWriteRef.current = value
    },
    setCursorOffset,
    setPastedContents,
  })

  const nextPasteIdRef = useRef<number | null>(null)
  if (nextPasteIdRef.current === null) {
    let max = 0
    for (const message of messages) {
      const content = (message as { message?: { content?: unknown } }).message?.content
      if (typeof content === 'string') {
        for (const ref of parseReferences(content)) max = Math.max(max, ref.id)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const text = (block as { text?: string }).text
          if (typeof text === 'string') {
            for (const ref of parseReferences(text)) max = Math.max(max, ref.id)
          }
        }
      }
      const ids = (message as { imagePasteIds?: number[] }).imagePasteIds
      if (Array.isArray(ids)) for (const id of ids) max = Math.max(max, id)
    }
    nextPasteIdRef.current = max + 1
  }
  const allocatePasteId = (): number => {
    const taken = new Set<number>(
      Object.keys(pendingInput.pastedContents()).map(Number),
    )
    for (const ref of parseReferences(pendingInput.text())) taken.add(ref.id)
    let id = nextPasteIdRef.current ?? 1
    while (taken.has(id)) id++
    nextPasteIdRef.current = id + 1
    return id
  }

  const insertAtCursor = (text: string, options?: { atomic?: boolean }): void => {
    if (!options?.atomic) buffer.pushToBuffer(input, cursorOffset, pastedContents);
    else buffer.pushAtomic(input, cursorOffset, pastedContents);
    const range = inputSelectionRangeRef.current();
    const start = range ? range.start : Math.max(0, Math.min(cursorOffset, input.length))
    const end = range ? range.end : start
    let payload = text
    if (
      !range &&
      start === input.length &&
      input !== '' &&
      !/\s$/.test(input) &&
      payload !== ''
    ) {
      payload = ` ${payload}`
    }
    const next = input.slice(0, start) + payload + input.slice(end)
    pendingInput.edit(next)
    lastSelfWriteRef.current = next
    setCursorOffset(start + payload.length)
  }

  const handleImagePaste = useCallback(
    (
      base64Image: string,
      mediaType?: string,
      filename?: string,
      dimensions?: ImageDimensions,
      sourcePath?: string,
      byteLength?: number,
    ): void => {
      setMode('prompt')
      const pendingSpace = deferredSpaceArmedRef.current
      const id = allocatePasteId()
      const entry: PastedContent = {
        id,
        type: 'image',
        content: base64Image,
        mediaType: mediaType ?? 'image/png',
        filename: filename ?? `image-${id}.png`,
        ...(dimensions ? { dimensions } : {}),
        ...(sourcePath ? { sourcePath } : {}),
      } as PastedContent
      cacheImagePath(entry)
      void storeImage(entry).catch(() => {})
      setPastedContents(prev => ({ ...prev, [id]: entry }))
      insertAtCursor(`${pendingSpace ? ' ' : ''}${formatImageRef(id)}`, { atomic: true })
      deferredSpaceArmedRef.current = true
      const bytes = byteLength ?? Math.floor((base64Image.length * 3) / 4)
      addNotification({
        key: `image-attached-${id}`,
        text: `${formatImageRef(id)} attached — ${describeAttachedImage(dimensions, bytes)}`,
        priority: 'low',
        timeoutMs: 4000,
      })
    },
    [insertAtCursor, setMode, setPastedContents, addNotification],
  )

  const handleImageError = useCallback(
    (message: string): void => {
      addNotification({
        key: 'image-attach-failed',
        text: message,
        color: 'warning',
        priority: 'high',
        timeoutMs: 10000,
      })
    },
    [addNotification],
  )

  const handleTextPaste = useCallback(
    (raw: string): void => {
      deferredSpaceArmedRef.current = false
      const text = stripControls(normalizePastedInput(raw))
      const lineCount = (text.match(/\n/g) ?? []).length + 1
      if (
        input === '' &&
        lineCount === 1 &&
        text.length <= PASTE_THRESHOLD &&
        getModeFromInput(text) === 'bash'
      ) {
        setMode('bash')
        const remainder = expandTabs(getValueFromInput(text))
        buffer.pushAtomic(input, cursorOffset, pastedContents)
        pendingInput.edit(remainder)
        lastSelfWriteRef.current = remainder
        setCursorOffset(remainder.length)
        return
      }
      const lineCap = Math.max(1, Math.min(rows - 10, 2))
      if (text.length > PASTE_THRESHOLD || lineCount > lineCap) {
        const id = allocatePasteId()
        const numLines = getPastedTextRefNumLines(text)
        const contentHash = hashPastedText(text)
        const entry: PastedContent = {
          id,
          type: 'text',
          content: text,
          contentHash,
        } as PastedContent
        void storePastedText(contentHash, text).catch(() => {})
        setPastedContents(prev => ({ ...prev, [id]: entry }))
        insertAtCursor(formatPastedTextRef(id, numLines), { atomic: true })
        return
      }
      insertAtCursor(expandTabs(text), { atomic: true })
    },
    [input, rows, cursorOffset, pastedContents, buffer, insertAtCursor, setMode, setCursorOffset, setPastedContents],
  )

  const cursorRef = useRef(cursorOffset)
  cursorRef.current = cursorOffset
  insertTextRef.current = {
    get cursorOffset() {
      return cursorRef.current
    },
    insert: (text: string) => insertAtCursor(text, { atomic: true }),
    setInputWithCursor: (value: string, cursor: number) => {
      pendingInput.edit(value)
      lastSelfWriteRef.current = value
      setCursorOffset(Math.max(0, Math.min(cursor, value.length)))
    },
  }
  setComposerInsert(text => insertAtCursor(text, { atomic: true }))
  useEffect(() => {
    return () => {
      insertTextRef.current = null
      setComposerInsert(null)
      void pendingInput.flushDrafts()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only flush
  }, [])

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
      pendingInput.edit(value)
      lastSelfWriteRef.current = value
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
  const sameDispatchSubmitRef = useRef(false)
  const submit = useCallback(
    async (
      raw: string,
      options: { fromKeybinding?: boolean; isSlashPick?: boolean },
    ): Promise<void> => {
      if (compactWork !== undefined && compactWork.read() !== 'composer') return
      const value = raw.replace(/\s+$/, '')
      const fresh = appStateStore.getState() as AppState

      if (fresh.footerSelection !== null) {
        const stillVisible =
          fresh.footerSelection === 'tasks'
            ? Object.values(fresh.tasks).some(isManageableTask) ||
              fresh.viewingAgentTaskId !== undefined
            : fresh.footerSelection === 'bagel'
                ? fresh.bagelActive === true
                : fresh.remoteControlEnabled
        if (stillVisible) return
      }
      if (fresh.viewSelectionMode === 'selecting-agent') return

      const hasImages = Object.values(pendingInput.pastedContents()).some(
        entry => (entry as { type?: string }).type === 'image',
      )

      const suggestion = suggestionApi.suggestion
      const suggestionSeen =
        ((fresh as { promptSuggestion?: { shownAt?: number | null } })
          .promptSuggestion?.shownAt ?? 0) > 0
      let submitted = value
      let speculationAccept:
        | {
            state: unknown
            speculationSessionTimeSavedMs: number
            setAppState: (f: (prev: AppState) => AppState) => void
          }
        | undefined
      if (
        suggestion !== null &&
        suggestionSeen &&
        !hasImages &&
        composerTargetTaskId(fresh) === undefined &&
        (value === '' || value === suggestion)
      ) {
        suggestionApi.markAccepted()
        submitted = suggestion
        const spec = (fresh as { speculation?: { status?: string } }).speculation
        if (spec?.status === 'active') {
          const savedMs =
            (fresh as { speculationSessionTimeSavedMs?: number }).speculationSessionTimeSavedMs ?? 0
          handleSpeculationAccept(spec, savedMs, setAppState, suggestion, undefined)
          speculationAccept = {
            state: spec,
            speculationSessionTimeSavedMs: savedMs,
            setAppState,
          }
        }
      }

      if (!options.fromKeybinding) {
        if (sameDispatchSubmitRef.current) return
        sameDispatchSubmitRef.current = true
        queueMicrotask(() => {
          sameDispatchSubmitRef.current = false
        })
      }

      if (isCrewEnabled() && crewContext !== undefined && submitted.startsWith('@')) {
        const parsed = parseDirectMemberMessage(submitted)
        if (parsed !== null) {
          const result = await sendDirectMemberMessage(
            parsed.recipientName,
            parsed.message,
            crewContext,
            sendLiveMessage,
          )
          if (result.success) {
            pendingInput.clearForSubmit(submitted)
            pendingInput.edit('')
            lastSelfWriteRef.current = ''
            buffer.clearBuffer()
            history.resetHistory()
            setCursorOffset(0)
            addNotification({
              key: 'direct-message-sent',
              text: `sent to @${result.recipientName}`,
              priority: 'medium',
              timeoutMs: 3000,
              fold: (_accumulated, incoming) => incoming,
            })
            return
          }
        }
      }

      if (submitted === '' && !hasImages) return

      {
        const dangling = danglingReferences(submitted, pendingInput.pastedContents())
        if (dangling.length > 0) {
          addNotification({
            key: 'paste-ref-dangling',
            text: pasteUnavailableLine(dangling[0]!.match),
            color: 'warning',
            priority: 'high',
            timeoutMs: 8000,
          })
          return
        }
      }

      const open = suggestionsMirrorRef.current.suggestions
      const isSlashSubmission =
        options.isSlashPick === true || submitted.trimStart().startsWith('/')
      if (
        open.length > 0 &&
        !isSlashSubmission &&
        !open.every(item => item.description === 'directory')
      ) {
        return
      }

      suggestionApi.logOutcomeAtSubmission(
        submitted,
        speculationAccept !== undefined ? { skipReset: true } : undefined,
      )
      removeNotification('stash-hint')

      if (pendingInput.mode() === 'bash') {
        await onSubmit(submitted, helpers, speculationAccept, {
          fromKeybinding: options.fromKeybinding === true,
        })
        return
      }

      const targetId = composerTargetTaskId(fresh)
      if (targetId !== undefined) {
        const intent = classifyAgentViewSubmission(
          submitted,
          options.fromKeybinding === true,
          commands,
        )
        const targetName = composerCrewmateRef.current?.taskId === targetId ? composerCrewmateRef.current.name : targetId
        const sendReceipt = (text: string, color?: 'warning'): void =>
          addNotification({ key: 'crewmate-send', text, priority: 'medium', timeoutMs: 6000, ...(color !== undefined ? { color } : {}), fold: (_accumulated, incoming) => incoming })
        const takeLine = (): void => {
          pendingInput.clearForSubmit(submitted)
          pendingInput.edit('')
          lastSelfWriteRef.current = ''
          buffer.clearBuffer()
          history.resetHistory()
          setCursorOffset(0)
        }
        const handBack = (): void => {
          const restored = `${submitted}${pendingInput.text()}`
          pendingInput.edit(restored)
          lastSelfWriteRef.current = restored
          setCursorOffset(restored.length)
        }
        const deliver = async (text: string): Promise<boolean> => {
          if (onAgentSubmit) {
            onAgentSubmit(text)
            return true
          }
          const task = fresh.tasks[targetId]
          if (task !== undefined && isInProcessCrewmateTask(task)) {
            injectUserMessageToCrewmate(task.id, text, setAppState)
            return true
          }
          if (task !== undefined && isLocalAgentTask(task)) {
            if (task.status !== 'running') {
              sendReceipt(crewmateRefusedWords(targetName, CREWMATE_BETWEEN_TURNS_DETAIL), 'warning')
              return false
            }
            queueOperatorMessage(task.id, text, setAppState)
            appendMessageToLocalAgent(
              task.id,
              { ...createUserMessage({ content: text }), queued: true },
              setAppState,
            )
            sendReceipt(`${operatorLinePlate(targetName)} ${crewmateQueuedWords(targetName)}`)
            return true
          }
          queueCrewmateLine(targetId, text)
          const receipt = await getFocusedSessionConnector().resumeAgent(targetId, text)
          if (receipt.outcome !== 'applied') {
            const why = receipt.detail ?? 'no reason given'
            refuseCrewmateLine(targetId, text, targetName, why)
            sendReceipt(crewmateRefusedWords(targetName, why), 'warning')
            return false
          }
          const queued = typeof receipt.detail === 'string' && receipt.detail.includes('"queued":true')
          sendReceipt(`${operatorLinePlate(targetName)} ${queued ? crewmateQueuedWords(targetName) : crewmateResumedWords(targetName)}`)
          return true
        }
        switch (intent.kind) {
          case 'session-command':
            await onSubmit(submitted, helpers, undefined, {
              fromKeybinding: options.fromKeybinding === true,
            })
            return
          case 'unknown-command':
            addNotification({
              key: 'agent-view-unknown-command',
              text: `Unknown command: /${intent.bareName} — commands run in this session; ${DOUBLED_SLASH} sends the line to the agent as text`,
              priority: 'medium',
              timeoutMs: 6000,
            })
            return
          case 'agent-literal':
          case 'agent-command':
          case 'agent-guidance': {
            takeLine()
            if (!(await deliver(intent.kind === 'agent-literal' ? intent.text : submitted))) handBack()
            return
          }
        }
      }

      await onSubmit(submitted, helpers, speculationAccept, {
        fromKeybinding: options.fromKeybinding === true,
      })
    },
    [appStateStore, suggestionApi, crewContext, commands, helpers, buffer, history, onSubmit, onAgentSubmit, setAppState, setCursorOffset, addNotification, removeNotification],
  )

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

  const performUndo = useCallback((): void => {
    const entry = buffer.undo({ text: pendingInput.text(), cursorOffset, pastedContents: pendingInput.pastedContents() })
    if (entry === undefined) return
    pendingInput.edit(entry.text)
    lastSelfWriteRef.current = entry.text
    setCursorOffset(entry.cursorOffset)
    pendingInput.setPastedContents(entry.pastedContents)
    addNotification({ key: 'edit-history', text: 'undid the last edit', priority: 'low', timeoutMs: 2000, fold: (_accumulated, incoming) => incoming })
  }, [buffer, input, cursorOffset, pastedContents, setCursorOffset, addNotification])
  const performRedo = useCallback((): void => {
    const entry = buffer.redo({ text: pendingInput.text(), cursorOffset, pastedContents: pendingInput.pastedContents() })
    if (entry === undefined) return
    pendingInput.edit(entry.text)
    lastSelfWriteRef.current = entry.text
    setCursorOffset(entry.cursorOffset)
    pendingInput.setPastedContents(entry.pastedContents)
    addNotification({ key: 'edit-history', text: 'redid the last edit', priority: 'low', timeoutMs: 2000, fold: (_accumulated, incoming) => incoming })
  }, [buffer, input, cursorOffset, pastedContents, setCursorOffset, addNotification])

  const openExternalEditor = useCallback(async (): Promise<void> => {
    if (input.trim() === '' && Object.keys(pastedContents).length === 0) {
      addNotification({
        key: 'external-editor-empty',
        text: `type a draft first — ${getShortcutDisplay('chat:externalEditor', 'Chat', 'ctrl+x ctrl+e')} edits the current draft`,
        priority: 'medium',
        timeoutMs: 5000,
      })
      return
    }
    setExternalEditorActive(true)
    try {
      const expanded = expandPastedTextRefs(input, pastedContents)
      const result = await editPromptInEditor(expanded)
      if (result.error) {
        addNotification({
          key: 'external-editor-error',
          text: `external editor failed: ${result.error}`,
          color: 'warning',
          priority: 'high',
        })
      } else if (typeof result.content === 'string' && result.content !== expanded) {
        buffer.pushAtomic(input, cursorOffset, pastedContents)
        pendingInput.edit(result.content)
        const edited = pendingInput.text()
        lastSelfWriteRef.current = edited
        setCursorOffset(edited.length)
      }
    } catch (error) {
      addNotification({
        key: 'external-editor-error',
        text: `external editor failed: ${error instanceof Error ? error.message : String(error)}`,
        color: 'warning',
        priority: 'high',
      })
    } finally {
      setExternalEditorActive(false)
    }
  }, [input, pastedContents, cursorOffset, buffer, setCursorOffset, addNotification])

  const performStash = useCallback((): void => {
    if (input.trim() === '') {
      const stashed = pendingInput.popStash()
      if (stashed === undefined) return
      lastSelfWriteRef.current = stashed.text
      setCursorOffset(stashed.cursorOffset)
      return
    }
    pendingInput.stashDraft(cursorOffset)
    lastSelfWriteRef.current = ''
    setCursorOffset(0)
    saveGlobalConfig(config => ({ ...config, hasUsedStash: true }))
  }, [input, cursorOffset, setCursorOffset])

  const cyclePermission = useCallback((): void => {
    const fresh = appStateStore.getState() as AppState
    if (
      isCrewEnabled() &&
      fresh.viewingAgentTaskId !== undefined &&
      fresh.tasks[fresh.viewingAgentTaskId] !== undefined &&
      isInProcessCrewmateTask(fresh.tasks[fresh.viewingAgentTaskId])
    ) {
      const taskId = fresh.viewingAgentTaskId
      setAppState(prev => {
        const task = prev.tasks[taskId]
        if (task === undefined || !isInProcessCrewmateTask(task)) return prev
        const next = getNextPermissionMode({
          ...getEmptyToolPermissionContext(),
          mode: task.permissionMode ?? 'default',
        })
        if (next === task.permissionMode) return prev
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...task, permissionMode: next },
          },
        }
      })
      setHelpOpen(false)
      return
    }
    const { nextMode, context: nextContext } = cyclePermissionMode(
      toolPermissionContext,
      crewContext,
    )
    setToolPermissionContext({ ...nextContext, mode: nextMode })
    syncCrewmateMode(nextMode, crewContext?.crewName)
    setHelpOpen(false)
  }, [appStateStore, toolPermissionContext, crewContext, setToolPermissionContext, setAppState, setHelpOpen])

  useKeybindings(
    {
      'chat:undo': () => {
        performUndo()
      },
      'chat:redo': () => {
        performRedo()
      },
      'chat:newline': () => {
        insertAtCursor('\n')
      },
      'chat:externalEditor': () => {
        void openExternalEditor()
      },
      'chat:stash': () => {
        performStash()
      },
      'chat:modelPicker': () => {
        setOverlay(current => (current === 'model-picker' ? null : 'model-picker'))
        setHelpOpen(false)
      },
      'chat:thinkingToggle': () => {
        setOverlay(current => (current === 'thinking-toggle' ? null : 'thinking-toggle'))
        setHelpOpen(false)
      },
      'chat:cycleMode': () => {
        cyclePermission()
      },
      'chat:imagePaste': () => {
        void (async () => {
          let image: Awaited<ReturnType<typeof getImageFromClipboard>>
          try {
            image = await getImageFromClipboard()
          } catch (error) {
            handleImageError(error instanceof Error ? error.message : String(error))
            return
          }
          if (image === null) {
            addNotification({
              key: 'no-image-in-clipboard',
              text:
                process.env.SSH_TTY !== undefined
                  ? 'no image in the clipboard (over SSH, transfer the file instead)'
                  : 'no image in the clipboard (copy one, then press the paste chord)',
              priority: 'low',
              timeoutMs: 1000,
            })
            return
          }
          handleImagePaste(
            image.base64,
            image.mediaType,
            undefined,
            image.dimensions,
            undefined,
            image.byteLength,
          )
        })()
      },
    },
    { context: 'Chat', isActive: !modalOverlayUp },
  )
  useKeybinding('app:commandPalette', () => {
    setShowCommandPalette(true)
  }, { context: 'Global', isActive: !modalOverlayUp })
  useKeybinding('app:fileOpen', () => {
    setShowFileOpen(true)
  }, { context: 'Global', isActive: !modalOverlayUp })
  useKeybinding('app:contentSearch', () => {
    setShowContentSearch(true)
  }, { context: 'Global', isActive: !modalOverlayUp })
  useKeybinding(
    'chat:messageActions',
    () => {
      if (onMessageActionsEnter && !isSearchingHistory) onMessageActionsEnter()
    },
    { context: 'Chat', isActive: !modalOverlayUp && !isSearchingHistory },
  )
  useKeybinding(
    'help:dismiss',
    () => {
      setHelpOpen(false)
    },
    { context: 'Help', isActive: helpOpen },
  )
  useKeybinding(
    'app:interrupt',
    () => {
      abortSpeculation(setAppState)
    },
    { context: 'Global', isActive: !isLoading && speculationActive },
  )

  const [crewmateFooterIndex, setCrewmateFooterIndex] = useState(0)
  const runningCrewmateCount = useAppState(
    (s: AppState) =>
      Object.values(s.tasks).filter(
        task => isInProcessCrewmateTask(task) && task.status === 'running',
      ).length,
  )
  useKeybindings(
    {
      'footer:up': () => {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      },
      'footer:down': () => {
        if (footerSelection === 'tasks' && runningCrewmateCount === 0) {
          setOverlay('tasks-dialog')
          setAppState(prev => ({ ...prev, footerSelection: null }))
        }
      },
      'footer:next': () => {
        if (runningCrewmateCount > 0 && footerSelection === 'tasks') {
          setCrewmateFooterIndex(prev => (prev + 1) % (1 + runningCrewmateCount))
        }
      },
      'footer:previous': () => {
        if (runningCrewmateCount > 0 && footerSelection === 'tasks') {
          setCrewmateFooterIndex(
            prev => (prev + runningCrewmateCount) % (1 + runningCrewmateCount),
          )
        }
      },
      'footer:openSelected': () => {
        const fresh = appStateStore.getState() as AppState
        if (fresh.viewSelectionMode === 'selecting-agent') return
        if (footerSelection === 'tasks') {
          if (runningCrewmateCount > 0) {
            if (crewmateFooterIndex === 0) exitCrewmateView(setAppState)
            else {
              const sorted = Object.values(fresh.tasks)
                .filter(isInProcessCrewmateTask)
                .filter(task => task.status === 'running')
                .sort((a, b) =>
                  (a.identity.agentName ?? '').localeCompare(b.identity.agentName ?? ''),
                )
              const target = sorted[crewmateFooterIndex - 1]
              if (target !== undefined) enterCrewmateView(target.id, setAppState)
            }
            return
          }
          setOverlay('tasks-dialog')
          setCrewmateFooterIndex(0)
          setAppState(prev => ({ ...prev, footerSelection: null }))
        }
      },
      'footer:clearSelection': () => {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      },
      'footer:close': () => false,
    },
    { context: 'Footer', isActive: footerSelection !== null && !modalOverlayUp },
  )

  const escapeDoublePress = useDoublePress(
    () => {},
    () => {
      onShowMessageSelector()
    },
  )
  const handleRawKey = useCallback(
    (
      rawInput: string,
      key: Key,
      event: { stopImmediatePropagation: () => void; seq?: number },
    ): void => {
      if (modalOverlayUp || popupOwnsKeys() || compactWork?.read() === 'summary' || compactWork?.read() === 'detail') return
      if (currentSurfaceRoute().kind !== 'repl') return
      if (event.seq !== undefined && isPriorGenerationInput(event.seq)) return

      const focusPane = getHelmFocus()

      if (focusPane !== 'prompt') {
        const composing = focusPane === 'telemetry' && isConsoleComposing()
        if (composing) {
          event.stopImmediatePropagation()
          if (key.escape) {
            if (!consoleAbortAsk()) exitConsoleCompose()
            return
          }
          if (key.tab) {
            exitConsoleCompose()
            setHelmFocus(nextHelmPane(focusPane))
            return
          }
          if (key.return) {
            const buffered = getConsoleBuffer()
            if (buffered.trim() !== '') {
              const context = getToolUseContext(
                messages,
                [],
                new AbortController(),
                engineModel ?? '',
              )
              consoleSubmitBuffer((question, controller) =>
                runConsoleAsk({
                  question,
                  context,
                  abortController: controller,
                }),
              )
            }
            return
          }
          if (key.backspace || rawInput === '\u007f') {
            consoleBackspace()
            return
          }
          if (key.delete) {
            consoleDeleteForward()
            return
          }
          if (key.leftArrow) {
            consoleMoveCursor(-1)
            return
          }
          if (key.rightArrow) {
            consoleMoveCursor(1)
            return
          }
          if (key.ctrl && rawInput === 'a') {
            consoleCursorHome()
            return
          }
          if (key.ctrl && rawInput === 'e') {
            consoleCursorEnd()
            return
          }
          if (key.ctrl && rawInput === 'k') {
            consoleKillLine()
            return
          }
          if (key.ctrl && rawInput === 'w') {
            consoleKillWord()
            return
          }
          if (key.ctrl && rawInput === 'l') {
            consoleClear()
            return
          }
          if (key.upArrow) {
            consoleHistoryMove(-1)
            return
          }
          if (key.downArrow) {
            consoleHistoryMove(1)
            return
          }
          if (
            rawInput !== '' &&
            !key.ctrl &&
            !key.meta &&
            rawInput >= ' '
          ) {
            consoleInsert(rawInput)
          }
          return
        }
        if (key.escape) {
          event.stopImmediatePropagation()
          setHelmFocus('prompt')
          return
        }
        if (key.tab) {
          event.stopImmediatePropagation()
          cycleHelmFocus()
          return
        }
        if (key.upArrow || key.downArrow) {
          event.stopImmediatePropagation()
          moveHelmCursor(focusPane, key.downArrow ? 1 : -1)
          return
        }
        if (key.return) {
          event.stopImmediatePropagation()
          if (!helmRailPastEntryBuffer()) return
          requestHelmRowActivation(focusPane, getHelmCursor(focusPane))
          return
        }
        if (rawInput === 'm' && !key.ctrl && !key.meta && focusPane === 'lanes') {
          const row = currentHelmRow('lanes')
          if (row !== undefined && (row.kind === 'crewmate' || row.kind === 'main')) {
            event.stopImmediatePropagation()
            if (!helmRailPastEntryBuffer()) return
            if (row.kind === 'main') clearMainChat(setAppState)
            else {
              setMainChat(row.id, setAppState)
              enterCrewmateView(row.id, setAppState)
            }
            setHelmFocus('prompt')
            return
          }
        }
        if (rawInput === 'c' && !key.ctrl && !key.meta && focusPane === 'lanes') {
          const row = currentHelmRow('lanes')
          if (row !== undefined && row.kind === 'crewmate') {
            event.stopImmediatePropagation()
            if (!helmRailPastEntryBuffer()) return
            const ledgerRow = (appStateStore.getState() as AppState).crewLedger[row.id]
            const facts = ledgerRow?.facts ?? { name: row.id, running: true }
            const cleared = clearCrewmate(row.id, setAppState)
            addNotification({ key: 'crewmate-send', text: cleared ? crewClearedWords(facts.name) : crewClearRefusedWords(facts), priority: 'medium', timeoutMs: 5000, fold: (_accumulated, incoming) => incoming })
            return
          }
        }
        if (
          rawInput !== '' &&
          !key.ctrl &&
          !key.meta &&
          rawInput >= ' ' &&
          !key.tab
        ) {
          const composeCapable = focusPane === 'telemetry' && consoleEnabled()
          event.stopImmediatePropagation()
          if (composeCapable) {
            beginConsoleCompose(rawInput)
          } else {
            setHelmFocus('prompt')
            insertAtCursor(rawInput)
          }
          return
        }
        return
      }

      const emptyPlainPrompt =
        input === '' && cursorOffset === 0 && mode === 'prompt' &&
        footerSelection === null && !helpOpen && !isSearchingHistory

      if (key.escape && voice.phase !== 'recording' && mode === 'prompt' && footerSelection === null && !helpOpen && !isSearchingHistory) {
        const freshState = appStateStore.getState() as AppState
        const viewed = freshState.viewingAgentTaskId
        if (viewed !== undefined) {
          event.stopImmediatePropagation()
          const crewmate = viewedCrewmateRef.current?.taskId === viewed ? viewedCrewmateRef.current : null
          const name = crewmate?.name ?? viewed
          const say = (text: string): void => addNotification({ key: 'crewmate-send', text, priority: 'medium', timeoutMs: 5000, fold: (_accumulated, incoming) => incoming })
          const road = interruptCrewmate(viewed, freshState, setAppState, undefined, {
            facts: crewmate?.facts ?? null,
            onRefused: detail => say(crewmateInterruptRefusedWords(name, detail)),
          })
          if (road === 'idle') {
            exitCrewmateView(setAppState)
            say(crewmateEscBackWords(name, crewmate?.facts != null ? crewStateLabel(crewmate.facts) : 'between turns'))
            return
          }
          say(crewmateInterruptedWords(name))
          return
        }
      }

      if (voice.phase === 'recording' && key.escape) {
        event.stopImmediatePropagation()
        cancelVoiceCapture()
        return
      }

      if (
        key.tab &&
        !key.shift &&
        emptyPlainPrompt &&
        suggestionsMirrorRef.current.suggestions.length === 0
      ) {
        if (cockpitActive) {
          event.stopImmediatePropagation()
          setHelmFocus('lanes')
          return
        }
      }

      if (
        emptyPlainPrompt &&
        key.meta &&
        !key.ctrl &&
        (key.leftArrow || key.rightArrow)
      ) {
        event.stopImmediatePropagation()
        void submitRef.current(SESSION_TAB_COMMAND, { fromKeybinding: true })
        return
      }

      if (emptyPlainPrompt && key.leftArrow && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        void submitRef.current(MANAGER_COMMAND, { fromKeybinding: true })
        return
      }

      if (getPlatform() === 'macos' && rawInput.length === 1 && 'åß∂ƒ©˙∆˚¬…æ∑'.includes(rawInput)) {
        addNotification({
          key: 'option-meta-hint',
          text: `option produced “${rawInput}” — run ${KEYSETUP_COMMAND} to make option send meta`,
          priority: 'low',
          timeoutMs: 5000,
        })
      }

      if (
        footerSelection !== null &&
        rawInput !== '' &&
        !key.ctrl &&
        !key.meta &&
        !key.escape &&
        !key.return &&
        rawInput >= ' '
      ) {
        event.stopImmediatePropagation()
        insertAtCursor(rawInput)
        return
      }

      if (
        cursorOffset === 0 &&
        (key.escape || key.backspace || key.delete || (key.ctrl && rawInput === 'u'))
      ) {
        if (mode === 'bash') {
          setMode('prompt')
          setHelpOpen(false)
        } else if (helpOpen && (key.backspace || key.delete) && input === '') {
          setHelpOpen(false)
        }
      }

      if (key.escape) {
        if (speculationActive) {
          abortSpeculation(setAppState)
          event.stopImmediatePropagation()
          return
        }
        if (helpOpen) {
          setHelpOpen(false)
          event.stopImmediatePropagation()
          return
        }
        if (footerSelection !== null) return
        if (messages.length > 0 && input === '' && !isLoading) {
          escapeDoublePress()
        }
        return
      }

      if (key.return && helpOpen) {
        setHelpOpen(false)
      }
    },
    [modalOverlayUp, input, cursorOffset, mode, footerSelection, helpOpen, isSearchingHistory, messages, isLoading, speculationActive, appStateStore, engineModel, cockpitActive, getToolUseContext, insertAtCursor, setMode, setHelpOpen, setCursorOffset, setAppState, addNotification, escapeDoublePress, voice.phase],
  )
  useInput((rawInput, key, event) => {
    handleRawKey(rawInput, key, event)
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

  const effortText = getEffortNotificationText(
    effortValue,
    engineModel ?? focusedMainModel,
  )
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
  const cellSpanAt =(localCol: number, localRow: number): { start: number; end: number } => {
    const cursor = Cursor.fromText(input, textColumns, cursorOffset)
    const viewportStart =
      composerViewportStartRef.current ?? cursor.getViewportStartLine(maxVisibleLines)
    const line = localRow + viewportStart
    const doc = cursor.measuredText
    const lineEnd = doc.getLineEndOffset(line)
    const start = Math.min(doc.getOffsetFromPosition({ line, column: localCol }), lineEnd)
    return { start, end: start < lineEnd ? doc.nextOffset(start) : start }
  }
  const offsetAtCell = (localCol: number, localRow: number): number => cellSpanAt(localCol, localRow).start
  const mapSelectionToInputRange = (): { start: number; end: number } | null => {
    if (isSearchingHistory) return null
    const state = selectionApi.getState()
    if (!state || !state.anchor || !state.focus) return null
    const box = inputBoxRef.current
    const rect = selectionGestureRectRef.current ?? (box ? nodeCache.get(box) : undefined)
    const trace = (why: string, start = -1, end = -1): void =>
      submitTrace('input-selection', '', {
        why,
        rx: rect?.x ?? -1, ry: rect?.y ?? -1, rw: rect?.width ?? -1, rh: rect?.height ?? -1,
        ac: state.anchor!.col, ar: state.anchor!.row, fc: state.focus!.col, fr: state.focus!.row,
        start, end, len: input.length,
      })
    if (!box) {
      trace('no-box')
      return null
    }
    if (!rect) {
      trace('no-rect')
      return null
    }
    const inside = (p: { col: number; row: number }): boolean =>
      p.col >= rect.x &&
      p.col < rect.x + rect.width &&
      p.row >= rect.y &&
      p.row < rect.y + rect.height
    if (!inside(state.anchor) || !inside(state.focus)) {
      trace('outside')
      return null
    }
    const [first, last] =
      state.anchor.row < state.focus.row ||
      (state.anchor.row === state.focus.row && state.anchor.col <= state.focus.col)
        ? [state.anchor, state.focus]
        : [state.focus, state.anchor]
    const start = offsetAtCell(first.col - rect.x, first.row - rect.y)
    const end = Math.min(
      input.length,
      offsetAtCell(last.col - rect.x, last.row - rect.y) + 1,
    )
    trace(start >= end ? 'degenerate' : 'ok', start, end)
    if (start >= end) return null
    return { start, end }
  }
  inputSelectionRangeRef.current =() => ownSelectionOf(pendingInput.text()) ?? mapSelectionToInputRange()
  useEffect(
    () =>
      registerInputSelectionOwner({
        range: () => inputSelectionRangeRef.current(),
        own: () => {
          const text = pendingInput.text()
          const range = ownSelectionOf(text)
          return range === null ? null : { ...range, text: text.slice(range.start, range.end) }
        },
        clear: clearOwnSelection,
      }),
    [],
  )
  const ownSelection = ownSelectionOf(input)
  const ownSelected = ownSelection !== null
  useEffect(() => {
    noteOwnInputSelectionChanged()
  }, [ownSelected])
  const pushAtomic = buffer.pushAtomic
  const insertTextAtCursor = (text: string): void => {
    insertAtCursor(text, { atomic: true })
  }
  const handleInputBoxClick = (event: { localCol: number; localRow: number }): void => {
    if (isSearchingHistory || input === '') return
    setCursorOffset(
      Math.max(0, Math.min(input.length, offsetAtCell(event.localCol, event.localRow))),
    )
  }
  const handleInputTextGesture =(gesture: TextGesture): boolean => {
    if (isSearchingHistory || isVimModeEnabled() || input === '') return false
    if (gesture.kind === 'press') {
      if (gesture.clickCount >= 2) {
        gestureAnchorRef.current = null
        setOwnSelection({ start: 0, end: input.length, of: input })
        setCursorOffset(input.length)
        return true
      }
      const cell = cellSpanAt(gesture.localCol, gesture.localRow)
      gestureAnchorRef.current = { ...cell, col: gesture.localCol, row: gesture.localRow, moved: false }
      setOwnSelection(null)
      setCursorOffset(cell.start)
      return true
    }
    if (gesture.kind === 'drag') {
      const anchor = gestureAnchorRef.current
      if (anchor === null) return true
      if (!anchor.moved) {
        if (gesture.localCol === anchor.col && gesture.localRow === anchor.row) return true
        anchor.moved = true
      }
      const cell = cellSpanAt(gesture.localCol, gesture.localRow)
      const forward = cell.start >= anchor.start
      const start = forward ? anchor.start : cell.start
      const end = forward ? Math.max(cell.end, anchor.end) : anchor.end
      setOwnSelection(start < end ? { start, end, of: input } : null)
      setCursorOffset(forward ? end : start)
      return true
    }
    gestureAnchorRef.current = null
    if (ownSelectionOf(input) !== null) noteOwnInputSelectionSettled()
    return true
  }

  const setOverlayDialog = useSetPromptOverlayDialog
  void setOverlayDialog

  const exitStateChange = useCallback((show: boolean, keyName?: string): void => {
    setExitState({ pending: show, keyName: keyName ?? null })
  }, [])

  const composerViewportStartRef = useRef<number | undefined>(undefined)

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
        pendingInput.edit(next)
        lastSelfWriteRef.current = next
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
          insertTextAtCursor(text)
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
          insertTextAtCursor(text)
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
          insertTextAtCursor(text)
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
