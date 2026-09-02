
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Box, Text, useInput } from '../../ink.js'
import { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import type { DOMElement } from '../../ink/dom.js'
import { nodeCache, type CachedLayout } from '../../ink/node-cache.js'
import { useSelection } from '../../ink/hooks/use-selection.js'
import { Cursor } from '../../utils/Cursor.js'
import { registerInputSelectionConsumer } from '../../utils/cockpit/inputSelectionBridge.js'
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
import { useIdeAtMentioned } from '../../hooks/useIdeAtMentioned.js'
import { useTypeahead, type SuggestionsState } from '../../hooks/useTypeahead.js'
import { useKeybinding, useKeybindings } from '../../keybindings/useKeybinding.js'
import { getShortcutDisplay } from '../../keybindings/shortcutFormat.js'
import type { IDESelection } from '../../hooks/useIdeSelection.js'
import type { VerificationStatus } from '../../hooks/useApiKeyVerification.js'
import type { MCPServerConnection } from '../../services/mcp/types.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import * as pendingInput from '../../input-core/pending-input.js'
import { cancelVoiceCapture, subscribeVoice, toggleVoiceCapture, voiceSnapshot } from '../../services/voice/voiceSession.js'
import { useAppState, useAppStateStore, useSetAppState, type AppState } from '../../state/AppState.js'
import {
  enterTeammateView,
  exitTeammateView,
} from '../../state/teammateViewHelpers.js'
import type { PromptInputMode } from '../../types/textInputTypes.js'
import type { ImageDimensions } from '../../utils/imageResizer.js'
import type { PastedContent } from '../../utils/config.js'
import type { Message } from '../../types/message.js'
import type { VimMode } from '../../types/textInputTypes.js'
import {
  consumeCommandDispatch,
  consumeHelmActivation,
  consumePromptPrefill,
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
import {
  beginMinervaCompose,
  exitMinervaCompose,
  getMinervaBuffer,
  isMinervaComposing,
  minervaAbortAsk,
  minervaBackspace,
  minervaCursorEnd,
  minervaCursorHome,
  minervaDeleteForward,
  minervaInsert,
  minervaKillLine,
  minervaMoveCursor,
  minervaReplEnabled,
  minervaSubmitBuffer,
} from '../../utils/cockpit/minervaRepl.js'
import { buildMinervaSessionDigest, runMinervaMessage } from '../../utils/tabula/minerva.js'
import { tabulaProjectDir } from '../../utils/tabula/tabulaGates.js'
import { currentInterviewRef } from '../../services/interview/store.js'
import { basename as pathBasename } from 'node:path'
import { classifyAgentViewSubmission } from './promptIntent.js'
import { MAIN_DRAFT_KEY, stashViewDraft, takeViewDraft } from './viewDrafts.js'
import { getModeFromInput, getValueFromInput, prependModeCharacterToInput } from './inputModes.js'
import { maybeTruncateMessageForInput } from './inputPaste.js'
import { normalizePastedInput } from '../../input-core/composer-document.js'
import { useMaybeTruncateInput } from './useMaybeTruncateInput.js'
import { usePromptInputPlaceholder } from './usePromptInputPlaceholder.js'
import { useSwarmBanner } from './useSwarmBanner.js'
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
import { HighlightedInput } from './ShimmeredInput.js'
import { IssueFlagBanner } from './IssueFlagBanner.js'
import TextInput from '../TextInput.js'
import VimTextInput from '../VimTextInput.js'
import ModelPicker from '../ModelPicker.js'
import { ThinkingToggle } from '../ThinkingToggle.js'
import { TransitionPreviewCard } from '../TransitionPreviewCard.js'
import { CapOfferCard } from '../CapOfferCard.js'
import { MercuryCommandPalette } from '../MercuryCommandPalette.js'
import { MercuryFileOpen } from '../MercuryFileOpen.js'
import { MercuryContentSearch } from '../MercuryContentSearch.js'
import { MercurySupercodeKeywordHint } from '../MercurySupercodeKeywordHint.js'
import { TeamsDialog } from '../teams/TeamsDialog.js'
import { BackgroundTasksDialog } from '../tasks/BackgroundTasksDialog.js'
import { isManageableTask } from '../tasks/taskStatusUtils.js'
import { isInProcessTeammateTask } from '../../tasks/InProcessTeammateTask/types.js'
import { injectUserMessageToTeammate } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import { appendMessageToLocalAgent, isLocalAgentTask, queuePendingMessage } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { getViewedTeammateTask } from '../../state/selectors.js'
import { writeToMailbox } from '../../utils/teammateMailbox.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { useFocusedTranscript } from '../../hooks/useFocusedTranscript.js'
import { useTheme } from '../design-system/ThemeProvider.js'
import { AGENT_COLOR_TO_THEME_COLOR } from '../../tools/AgentTool/agentColorManager.js'
import { findThinkingTriggerPositions, isDeepthinkEnabled } from '../../utils/thinking.js'
import { findSlashCommandPositions } from '../../utils/suggestions/commandSuggestions.js'
import { findSlackChannelPositions } from '../../utils/suggestions/slackChannelSuggestions.js'
import { findTokenBudgetPositions } from '../../utils/tokenBudget.js'
import type { TextHighlight } from '../../utils/textHighlighting.js'
import { createUserMessage } from '../../utils/messages/factories.js'
import { danglingReferences, getPastedTextRefNumLines, formatPastedTextRef, formatImageRef, parseReferences } from '../../history.js'
import { PASTE_THRESHOLD, getImageFromClipboard } from '../../utils/imagePaste.js'
import { cacheImagePath, storeImage } from '../../utils/imageStore.js'
import { editPromptInEditor } from '../../utils/promptEditor.js'
import { expandPastedTextRefs } from '../../history.js'
import {
  cyclePermissionMode,
  getNextPermissionMode,
} from '../../utils/permissions/getNextPermissionMode.js'
import { syncTeammateMode } from '../../utils/swarm/teamHelpers.js'
import { parseDirectMemberMessage, sendDirectMemberMessage } from '../../utils/directMemberMessage.js'
import { getEffortNotificationText } from '../EffortIndicator.js'
import { isDefaultMode } from '../../utils/permissions/PermissionMode.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { CockpitActiveContext } from '../../context/cockpitActiveContext.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { abortSpeculation, handleSpeculationAccept } from '../../services/PromptSuggestion/speculation.js'
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js'
import { composerBorderRole, composerBorderStyle, COMPOSER_BORDER_SHED_ROWS } from '../mercury-ui/replFloor.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import { getPlatform } from '../../utils/platform.js'
import { crossProviderNote, providerFamilyOfSetting, settleModelSelection, type TransitionPlan } from '../../utils/model/modelTransition.js'
import {
  previewForSelection,
  reconfirmTransitionPlan,
  transitionPlanSummary,
} from '../../services/providers/transitionPreview.js'
import { usabilityForRoute } from '../../services/providers/providerUsability.js'
import { declaredRouteOf, type CallModelRoute } from '../../services/providers/callModelRouter.js'
import { ANTHROPIC_CONNECT_OPTION_VALUE, GPT_CONNECT_OPTION_VALUE, parseKeyConnectValue } from '../../utils/model/modelOptions.js'
import { OPENROUTER_CONNECT_OPTION_VALUE } from '../../services/providers/openrouter/openrouterCatalogue.js'
import { HUGGINGFACE_CONNECT_OPTION_VALUE } from '../../services/providers/huggingface/huggingfaceCatalogue.js'
import { GEMINI_CONNECT_OPTION_VALUE } from '../../services/providers/gemini/geminiCatalogue.js'
import { requestCommandDispatch } from '../../utils/cockpit/helmFocus.js'
import { renderModelName } from '../../utils/model/model.js'
import {
  capHandoffState,
  decideCapAction,
  decideCapReturn,
  decideSlotWallAction,
  liveCapFailoverTarget,
  noteCapHandoff,
  noteCapReturn,
  noteOfferAutoDone,
  noteOfferDismissal,
  observedFamilyWindow,
  offerAutoDone,
  offerDismissed,
  resolveCapPosture,
} from '../../services/capFailover.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { slotSeatView, slotSwitchTransient, switchActiveSlot } from '../../services/providers/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../utils/model/slotSwitchReceipt.js'
import { openaiLimitWindow } from '../../services/providers/openai/openaiLimitState.js'
import { SlotOfferCard } from '../SlotOfferCard.js'
import { useClaudeAiLimits } from '../../services/claudeAiLimitsHook.js'
import { formatResetTime } from '../../utils/format.js'
import { AMBER } from '../mercuryPalette.js'
import type { Key } from '../../ink/events/input-event.js'
import { stringWidth } from '../../ink/stringWidth.js'
import stripAnsi from 'strip-ansi'
import { truncateToWidth } from '../mercury-ui/glyphs.js'
import { logForDebugging } from '../../utils/debug.js'
import { submitTrace } from '../../utils/submitTrace.js'
import { fluxMark, fluxWhy } from '../../utils/flux/fluxProbe.js'
import { familyDisplayName } from '../../services/providers/accountSlots.js'

const MANAGER_COMMAND = '/manager'
const SESSION_TAB_COMMAND = '/sessiontab'
const TERMINAL_SETUP_COMMAND = '/terminal-setup'
const DOUBLED_SLASH = '//'
const INPUT_TRUNCATION_THRESHOLD = 10_000
const UNDO_BUFFER_SIZE = 50
const UNDO_COALESCE_MS = 1000

type OverlaySurface =
  | null
  | 'tasks-dialog'
  | 'model-transition-preview'
  | 'model-picker'
  | 'thinking-toggle'
  | 'cap-offer'
  | 'slot-offer'

export type PromptInputProps = {
  debug: boolean
  ideSelection: IDESelection | undefined
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

function PromptInputInner(props: PromptInputProps): React.ReactNode {
  fluxMark('render:composer')
  const {
    debug,
    ideSelection,
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
  const { addNotification, removeNotification } = useNotifications()
  const setAppState = useSetAppState()
  const appStateStore = useAppStateStore()
  const messages = useFocusedTranscript() as Message[]
  const mainLoopModel = useAppState((s: AppState) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState(
    (s: AppState) => s.mainLoopModelForSession,
  )
  const effortValue = useAppState((s: AppState) => s.effortValue)
  const viewedTask = useAppState((s: AppState) =>
    s.viewingAgentTaskId !== undefined ? s.tasks[s.viewingAgentTaskId] : undefined,
  )
  const footerSelection = useAppState((s: AppState) => s.footerSelection)
  const viewSelectionMode = useAppState((s: AppState) => s.viewSelectionMode)
  const viewingAgentTaskId = useAppState((s: AppState) => s.viewingAgentTaskId)
  const teamContext = useAppState((s: AppState) => s.teamContext)
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
    mainLoopModel,
    mainLoopModelForSession,
    effortValue,
    viewedTask,
    footerSelection,
    viewSelectionMode,
    viewingAgentTaskId,
    teamContext,
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
  useEffect(
    () =>
      selectionApi.subscribe(() => {
        const state = selectionApi.getState()
        if (!state?.anchor) {
          selectionGestureRectRef.current = null
          return
        }
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
  useEffect(() => {
    const focusedId = getFocusedSessionConnector().sessionId()
    if (cursorSessionRef.current === focusedId) return
    const draft = pendingInput.readDraftFor(focusedId)
    if (draft !== null && draft.text === input && input !== '') {
      cursorSessionRef.current = focusedId
      if (typeof draft.cursorOffset === 'number') {
        setCursorOffset(Math.max(0, Math.min(draft.cursorOffset, input.length)))
      }
    } else if (input === '' && (draft === null || (draft.text ?? '') === '')) {
      cursorSessionRef.current = focusedId
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

  const stashPeakRef = useRef(0)

  const [overlay, setOverlay] = useState<OverlaySurface>(null)
  const [showTeamsDialog, setShowTeamsDialog] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  const [showFileOpen, setShowFileOpen] = useState(false)
  const [showContentSearch, setShowContentSearch] = useState(false)
  const [externalEditorActive, setExternalEditorActive] = useState(false)
  const [exitState, setExitState] = useState<{ pending: boolean; keyName: string | null }>({ pending: false, keyName: null })
  const [isPasting, setIsPasting] = useState(false)

  const modalOverlayUp =
    overlay !== null ||
    showTeamsDialog ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive ||
    hasSuppressedDialogs

  const [transitionConfirm, setTransitionConfirm] = useState<{
    value: string | null
    plan: TransitionPlan
    refreshed: boolean
  } | null>(null)
  const [capOffer, setCapOffer] = useState<{
    trigger: 'warning' | 'rejected' | 'reset'
    direction: 'handoff' | 'return'
    key: string
    windowName: string | null
    resetText: string | null
    targetModel: string
    targetRoute: CallModelRoute
    homeRoute: CallModelRoute
    awayRoute: CallModelRoute
  } | null>(null)
  const [slotOffer, setSlotOffer] = useState<{
    key: string
    family: 'anthropic' | 'openai'
    fromLabel: string
    toLabel: string
    headroomObserved: boolean
    resetText: string | null
  } | null>(null)
  const limits = useClaudeAiLimits()

  const applyModelSelection = (value: string | null): void => {
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = value === null ? 'Default' : renderModelName(value)
      setOverlay(null)
      const effectiveBefore = focused.modelFacts().effective
      void focused.setModel(value).then(receipt => {
        if (receipt.state === 'no-op') {
          addNotification({ key: 'model-switched', text: `Already on ${label} — nothing to change`, priority: 'high', timeoutMs: 3000 })
          return
        }
        if (receipt.state === 'refused') {
          addNotification({ key: 'model-switched', text: `The model switch was refused: ${receipt.detail}`, priority: 'high', timeoutMs: 5000 })
          return
        }
        const doorCross = providerFamilyOfSetting(effectiveBefore) !== providerFamilyOfSetting(value) ? crossProviderNote(value) : ''
        const doorPlan = previewForSelection(messages, effectiveBefore, value)
        const doorLossNote = transitionPlanSummary(doorPlan)
        addNotification(
          receipt.state === 'queued'
            ? {
                key: 'model-switched',
                invalidates: ['model-transition-applied'],
                text: `Model switch queued: ${label} applies when this session's turn settles (the running turn keeps its model)${doorCross}${doorLossNote}`,
                priority: 'high',
                timeoutMs: 5000,
              }
            : {
                key: 'model-switched',
                text: `Set model to ${label} — this session's next message runs it${doorCross}${doorLossNote}`,
                priority: 'high',
                timeoutMs: 3000,
              },
        )
      })
      return
    }
    const stateNow = appStateStore.getState()
    const settled = settleModelSelection(stateNow, value, {
      turnActive:
        stateNow.foregroundTurnActive || stateNow.pendingModelSwitch !== null,
    })
    const label = value === null ? 'Default' : renderModelName(value)
    setOverlay(null)
    if (settled.kind === 'no-op') {
      addNotification({ key: 'model-switched', text: `Already on ${label} — nothing to change`, priority: 'high', timeoutMs: 3000 })
      return
    }
    if (settled.kind === 'cancelled-pending') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      addNotification({ key: 'model-switched', text: `Already on ${label} — queued switch cancelled`, priority: 'high', timeoutMs: 3000 })
      return
    }
    const effectiveFrom = stateNow.mainLoopModelForSession ?? stateNow.mainLoopModel
    const lossNote = transitionPlanSummary(previewForSelection(messages, effectiveFrom, value))
    if (settled.kind === 'queued') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      addNotification({
        key: 'model-switched',
        invalidates: ['model-transition-applied'],
        text: `Model switch queued: ${label} applies when the current turn settles (the running turn keeps its model)${settled.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
        priority: 'high',
        timeoutMs: 5000,
      })
      return
    }
    setAppState(prev => ({ ...prev, ...settled.patch }))
    addNotification({
      key: 'model-switched',
      text: `Set model to ${label}${settled.receipt.crossProvider ? crossProviderNote(value) : ''}${lossNote}`,
      priority: 'high',
      timeoutMs: 3000,
    })
  }

  const handleModelSelect = (value: string | null): void => {
    if (value === ANTHROPIC_CONNECT_OPTION_VALUE) {
      setOverlay(null)
      requestCommandDispatch('/logins anthropic')
      return
    }
    if (
      value === GPT_CONNECT_OPTION_VALUE ||
      value === OPENROUTER_CONNECT_OPTION_VALUE ||
      value === GEMINI_CONNECT_OPTION_VALUE ||
      value === HUGGINGFACE_CONNECT_OPTION_VALUE
    ) {
      setOverlay(null)
      requestCommandDispatch('/logins')
      return
    }
    {
      const keyLane = value === null ? undefined : parseKeyConnectValue(value)
      if (keyLane !== undefined) {
        setOverlay(null)
        if (keyLane === 'compat') {
          addNotification({
            key: 'compat-configure',
            text: 'Custom endpoint: set MERCURY_COMPAT_BASE_URL (+ MERCURY_COMPAT_MODELS, optional MERCURY_COMPAT_API_KEY or /router key compat) — the rows go live next /model open',
            priority: 'high',
            timeoutMs: 6000,
          })
          return
        }
        requestCommandDispatch(`/logins ${keyLane}`)
        return
      }
    }
    const probeState = appStateStore.getState()
    const probe = settleModelSelection(probeState, value, {
      turnActive:
        probeState.foregroundTurnActive || probeState.pendingModelSwitch !== null,
    })
    if (probe.kind === 'queued' || probe.kind === 'applied') {
      const gatePlan = previewForSelection(
        messages,
        probeState.mainLoopModelForSession ?? probeState.mainLoopModel,
        value,
      )
      if (gatePlan.needsChoice) {
        setTransitionConfirm({ value, plan: gatePlan, refreshed: false })
        setOverlay('model-transition-preview')
        return
      }
    }
    applyModelSelection(value)
  }

  useEffect(() => {
    const posture = resolveCapPosture()
    {
      const factsNow = getFocusedSessionConnector().modelFacts()
      const effectiveModel = factsNow.sessionPin ?? factsNow.setting ?? factsNow.main
      const family = declaredRouteOf(effectiveModel)
      if (family === 'anthropic' || family === 'openai') {
        const view = slotSeatView(family)
        const activeWall = ((): { walled: boolean; resetsAtMs?: number } => {
          if (family === 'anthropic') {
            return limits.status === 'rejected'
              ? { walled: true, ...(limits.resetsAt !== undefined ? { resetsAtMs: limits.resetsAt * 1000 } : {}) }
              : { walled: false }
          }
          if (view.active === undefined) return { walled: false }
          const window = openaiLimitWindow(view.active === 'api-key' ? 'api-key' : 'chatgpt-subscription')
          return window.state === 'limited' ? { walled: true, resetsAtMs: window.resetsAtMs } : { walled: false }
        })()
        const action = decideSlotWallAction(posture, {
          activeWalled: activeWall.walled,
          otherSignedIn: view.other !== undefined,
          otherWalled: view.other?.walled === true,
        })
        if (action.kind !== 'none' && view.other !== undefined && view.activeLabel !== undefined) {
          const slotKey = `slot|${family}|${view.active ?? ''}|${activeWall.resetsAtMs ?? ''}`
          if (action.kind === 'offer') {
            const turnInFlightNow = appStateStore.getState().foregroundTurnActive
            if (turnInFlightNow) return
            if (!offerDismissed(slotKey) && !modalOverlayUp) {
              setSlotOffer({
                key: slotKey,
                family,
                fromLabel: view.activeLabel,
                toLabel: view.other.label,
                headroomObserved: view.other.wallKnown,
                resetText:
                  activeWall.resetsAtMs !== undefined
                    ? (formatResetTime(activeWall.resetsAtMs / 1000) ?? null)
                    : null,
              })
              setOverlay('slot-offer')
              return
            }
          } else if (!offerAutoDone(slotKey)) {
            noteOfferAutoDone(slotKey)
            const outcome = switchActiveSlot(family)
            const durable = paintSlotSwitchReceipt(outcome)
            addNotification({
              key: 'slot-failover',
              text: durable ? slotSwitchTransient(outcome.receipt) : outcome.receipt,
              priority: 'high',
              timeoutMs: 8000,
            })
            return
          }
        }
      }
    }
    if (posture === 'off') return
    const modelFactsNow = getFocusedSessionConnector().modelFacts()
    const effective =
      modelFactsNow.sessionPin ?? modelFactsNow.setting ?? modelFactsNow.main
    const liveRoute = declaredRouteOf(effective)
    const noted = capHandoffState()
    if (noted !== null && liveRoute === noted.homeFamily) {
      noteCapReturn()
      return
    }
    const onFailoverLane = noted !== null && liveRoute !== noted.homeFamily
    const homeFamily: string | null = noted !== null && onFailoverLane ? noted.homeFamily : liveRoute
    if (homeFamily === null) return
    const homeUsability = onFailoverLane ? usabilityForRoute(homeFamily as CallModelRoute) : null
    if (homeUsability !== null && homeUsability.credential === 'none') {
      noteCapReturn()
      return
    }
    const window = observedFamilyWindow(homeFamily)
    const action =
      onFailoverLane && homeUsability !== null
        ? decideCapReturn(posture, { window: window.state, credentialUsable: homeUsability.usable }, true)
        : decideCapAction(posture, window.state)
    if (action.kind === 'none') return
    const direction: 'handoff' | 'return' = onFailoverLane ? 'return' : 'handoff'
    const decisionKey = `${direction}|${homeFamily}|${window.state}|${window.resetsAtMs ?? ''}`
    const windowName = window.windowName ?? null
    const resetText =
      window.resetsAtMs !== undefined ? (formatResetTime(window.resetsAtMs / 1000) ?? null) : null
    const homeName = providerDisplayName(homeFamily)
    if (action.kind === 'offer') {
      if (offerDismissed(decisionKey)) return
      if (modalOverlayUp) return
      let target: string | null
      if (direction === 'return') {
        target = noted?.homeModel ?? getFocusedSessionConnector().modelFacts().main
      } else {
        target = liveCapFailoverTarget(homeFamily)?.model ?? null
      }
      if (target === null) return
      const targetRoute = declaredRouteOf(target)
      if (targetRoute === null) return
      const awayRouteResolved = direction === 'return' ? liveRoute : targetRoute
      if (awayRouteResolved === null) return
      setCapOffer({
        trigger: action.trigger,
        direction,
        key: decisionKey,
        windowName,
        resetText,
        targetModel: target,
        targetRoute,
        homeRoute: homeFamily as CallModelRoute,
        awayRoute: awayRouteResolved,
      })
      setOverlay('cap-offer')
      return
    }
    if (offerAutoDone(decisionKey)) return
    noteOfferAutoDone(decisionKey)
    if (direction === 'handoff') {
      const target = liveCapFailoverTarget(homeFamily)?.model
      if (target === undefined) return
      noteCapHandoff(effective, homeFamily)
      applyModelSelection(target)
      addNotification({
        key: 'cap-failover',
        text: `Usage handoff: ${renderModelName(target)} — the ${homeName} ${windowName ?? 'usage'} window is reached${resetText !== null ? ` · resets ${resetText}` : ''}`,
        priority: 'high',
        timeoutMs: 8000,
      })
      return
    }
    const home = noted?.homeModel ?? null
    noteCapReturn()
    applyModelSelection(home)
    addNotification({
      key: 'cap-failover',
      text: `Returned home: ${home === null ? 'Default' : renderModelName(home)} — the ${homeName} lane`,
      priority: 'high',
      timeoutMs: 8000,
    })
  })

  const viewedTeammate = getViewedTeammateTask(
    appStateStore.getState(),
  )
  const viewedAgentName =
    viewedTeammate?.identity?.agentName ??
    (viewedTask !== undefined && isLocalAgentTask(viewedTask)
      ? viewedTask.description !== ''
        ? viewedTask.description
        : viewedTask.agentType
      : undefined)
  const viewedAgentColor = viewedTeammate?.identity?.color

  const draftKey = viewingAgentTaskId ?? MAIN_DRAFT_KEY
  const draftKeyRef = useRef(draftKey)
  const liveTextRef = useRef(input)
  liveTextRef.current = input
  useEffect(() => {
    if (draftKeyRef.current === draftKey) return
    const previousKey = draftKeyRef.current
    draftKeyRef.current = draftKey
    stashViewDraft(previousKey, liveTextRef.current)
    const incoming = takeViewDraft(draftKey)
    pendingInput.edit(incoming)
    lastSelfWriteRef.current = incoming
    setCursorOffset(incoming.length)
  }, [draftKey, setCursorOffset])

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
          value.length === input.length + 1 &&
          value.startsWith(input) &&
          value.slice(input.length) !== ' ' &&
          value.slice(input.length).trim() !== ''
        ) {
          value = `${input} ${value.slice(input.length)}`
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
    },
    [insertAtCursor, setMode, setPastedContents],
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
        const entry: PastedContent = {
          id,
          type: 'text',
          content: text,
        } as PastedContent
        setPastedContents(prev => ({ ...prev, [id]: entry }))
        insertAtCursor(formatPastedTextRef(id, numLines), { atomic: true })
        return
      }
      insertAtCursor(expandTabs(text), { atomic: true })
    },
    [input, rows, cursorOffset, pastedContents, buffer, insertAtCursor, setMode, setCursorOffset, setPastedContents],
  )

  useIdeAtMentioned(mcpClients, atMentioned => {
    const mention = atMentioned as {
      filePath?: string
      lineStart?: number
      lineEnd?: number
    }
    if (typeof mention.filePath !== 'string') return
    const cwd = getFocusedSessionConnector().workspace().cwd
    const relative = mention.filePath.startsWith(cwd)
      ? mention.filePath.slice(cwd.length).replace(/^\//, '')
      : mention.filePath
    let ref = `@${relative}`
    if (typeof mention.lineStart === 'number') {
      ref +=
        typeof mention.lineEnd === 'number' && mention.lineEnd !== mention.lineStart
          ? `#L${mention.lineStart}-${mention.lineEnd}`
          : `#L${mention.lineStart}`
    }
    insertAtCursor(`${ref} `, { atomic: true })
  })

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
  useEffect(() => {
    return () => {
      insertTextRef.current = null
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
      return stringWidth(value) <= Math.max(1, columns - 3 - 1)
    },
    [columns],
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
      const value = raw.replace(/\s+$/, '')
      const fresh = appStateStore.getState() as AppState

      if (fresh.footerSelection !== null) {
        const stillVisible =
          fresh.footerSelection === 'tasks'
            ? Object.values(fresh.tasks).some(isManageableTask) ||
              fresh.viewingAgentTaskId !== undefined
            : fresh.footerSelection === 'teams'
              ? fresh.teamContext !== undefined &&
                Object.values(fresh.teamContext.teammates).length > 0
              : fresh.footerSelection === 'bagel'
                ? fresh.bagelActive === true
                : fresh.replBridgeEnabled
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
        fresh.viewingAgentTaskId === undefined &&
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

      if (isAgentSwarmsEnabled() && teamContext !== undefined && submitted.startsWith('@')) {
        const parsed = parseDirectMemberMessage(submitted)
        if (parsed !== null) {
          const result = await sendDirectMemberMessage(
            parsed.recipientName,
            parsed.message,
            teamContext,
            writeToMailbox,
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
            text: `${dangling[0]!.match} is no longer available — remove the reference or paste the content again`,
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

      if (fresh.viewingAgentTaskId !== undefined) {
        const intent = classifyAgentViewSubmission(
          submitted,
          options.fromKeybinding === true,
          commands,
        )
        const deliver = (text: string): void => {
          if (onAgentSubmit) {
            onAgentSubmit(text)
            return
          }
          const task = fresh.tasks[fresh.viewingAgentTaskId as string]
          if (task !== undefined && isInProcessTeammateTask(task)) {
            injectUserMessageToTeammate(task.id, text, setAppState)
          } else if (task !== undefined && isLocalAgentTask(task)) {
            queuePendingMessage(task.id, text, setAppState)
            appendMessageToLocalAgent(
              task.id,
              createUserMessage({ content: text }),
              setAppState,
            )
          }
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
            deliver(intent.text)
            break
          case 'agent-command':
          case 'agent-guidance':
            deliver(submitted)
            break
        }
        pendingInput.clearForSubmit(submitted)
        pendingInput.edit('')
        lastSelfWriteRef.current = ''
        buffer.clearBuffer()
        history.resetHistory()
        setCursorOffset(0)
        return
      }

      await onSubmit(submitted, helpers, speculationAccept, {
        fromKeybinding: options.fromKeybinding === true,
      })
    },
    [appStateStore, suggestionApi, teamContext, commands, helpers, buffer, history, onSubmit, onAgentSubmit, setAppState, setCursorOffset, addNotification, removeNotification],
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
        case 'teammate':
          enterTeammateView(activation.id, setAppState)
          setHelmFocus('prompt')
          break
        case 'main':
          exitTeammateView(setAppState)
          setHelmFocus('prompt')
          break
        case 'command':
          setHelmFocus('prompt')
          void submitRef.current(activation.command, { fromKeybinding: true })
          break
        case 'console':
          setHelmFocus('telemetry')
          beginConsoleCompose()
          break
        case 'minerva':
          setHelmFocus('lanes')
          beginMinervaCompose()
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
    const entry = buffer.undo({ text: input, cursorOffset, pastedContents })
    if (entry === undefined) return
    pendingInput.edit(entry.text)
    lastSelfWriteRef.current = entry.text
    setCursorOffset(entry.cursorOffset)
    pendingInput.setPastedContents(entry.pastedContents)
    addNotification({ key: 'edit-history', text: 'undid the last edit', priority: 'low', timeoutMs: 2000, fold: (_accumulated, incoming) => incoming })
  }, [buffer, input, cursorOffset, pastedContents, setCursorOffset, addNotification])
  const performRedo = useCallback((): void => {
    const entry = buffer.redo({ text: input, cursorOffset, pastedContents })
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
        lastSelfWriteRef.current = result.content
        setCursorOffset(result.content.length)
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
      const stashed = pendingInput.stashedPrompt()
      if (stashed === undefined) return
      pendingInput.setStash(undefined)
      pendingInput.edit(stashed.text)
      lastSelfWriteRef.current = stashed.text
      setCursorOffset(stashed.cursorOffset)
      pendingInput.setPastedContents(stashed.pastedContents)
      return
    }
    pendingInput.setStash({ text: input, cursorOffset, pastedContents })
    pendingInput.edit('')
    lastSelfWriteRef.current = ''
    setCursorOffset(0)
    pendingInput.setPastedContents({})
    saveGlobalConfig(config => ({ ...config, hasUsedStash: true }))
  }, [input, cursorOffset, pastedContents, setCursorOffset])

  const cyclePermission = useCallback((): void => {
    const fresh = appStateStore.getState() as AppState
    if (
      isAgentSwarmsEnabled() &&
      fresh.viewingAgentTaskId !== undefined &&
      fresh.tasks[fresh.viewingAgentTaskId] !== undefined &&
      isInProcessTeammateTask(fresh.tasks[fresh.viewingAgentTaskId])
    ) {
      const taskId = fresh.viewingAgentTaskId
      setAppState(prev => {
        const task = prev.tasks[taskId]
        if (task === undefined || !isInProcessTeammateTask(task)) return prev
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
      teamContext,
    )
    if (nextMode === 'strategy') {
      saveGlobalConfig(config => ({ ...config, lastPlanModeUse: Date.now() }))
    }
    setToolPermissionContext({ ...nextContext, mode: nextMode })
    syncTeammateMode(nextMode, teamContext?.teamName)
    setHelpOpen(false)
  }, [appStateStore, toolPermissionContext, teamContext, setToolPermissionContext, setAppState, setHelpOpen])

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
          const image = await getImageFromClipboard()
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

  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0)
  const runningTeammateCount = useAppState(
    (s: AppState) =>
      Object.values(s.tasks).filter(
        task => isInProcessTeammateTask(task) && task.status === 'running',
      ).length,
  )
  useKeybindings(
    {
      'footer:up': () => {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      },
      'footer:down': () => {
        if (footerSelection === 'tasks' && runningTeammateCount === 0) {
          setOverlay('tasks-dialog')
          setAppState(prev => ({ ...prev, footerSelection: null }))
          return
        }
        setAppState(prev => ({
          ...prev,
          footerSelection: prev.footerSelection === 'tasks' ? 'teams' : prev.footerSelection,
        }))
      },
      'footer:next': () => {
        if (runningTeammateCount > 0 && footerSelection === 'tasks') {
          setTeammateFooterIndex(prev => (prev + 1) % (1 + runningTeammateCount))
          return
        }
        setAppState(prev => ({
          ...prev,
          footerSelection: prev.footerSelection === 'tasks' ? 'teams' : prev.footerSelection,
        }))
      },
      'footer:previous': () => {
        if (runningTeammateCount > 0 && footerSelection === 'tasks') {
          setTeammateFooterIndex(
            prev => (prev + runningTeammateCount) % (1 + runningTeammateCount),
          )
          return
        }
        setAppState(prev => ({
          ...prev,
          footerSelection: prev.footerSelection === 'teams' ? 'tasks' : prev.footerSelection,
        }))
      },
      'footer:openSelected': () => {
        const fresh = appStateStore.getState() as AppState
        if (fresh.viewSelectionMode === 'selecting-agent') return
        if (footerSelection === 'tasks') {
          if (runningTeammateCount > 0) {
            if (teammateFooterIndex === 0) exitTeammateView(setAppState)
            else {
              const sorted = Object.values(fresh.tasks)
                .filter(isInProcessTeammateTask)
                .filter(task => task.status === 'running')
                .sort((a, b) =>
                  (a.identity.agentName ?? '').localeCompare(b.identity.agentName ?? ''),
                )
              const target = sorted[teammateFooterIndex - 1]
              if (target !== undefined) enterTeammateView(target.id, setAppState)
            }
            return
          }
          setOverlay('tasks-dialog')
          setTeammateFooterIndex(0)
          setAppState(prev => ({ ...prev, footerSelection: null }))
          return
        }
        if (footerSelection === 'teams') {
          setShowTeamsDialog(true)
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
      if (modalOverlayUp) return
      if (currentSurfaceRoute().kind !== 'repl') return
      if (event.seq !== undefined && isPriorGenerationInput(event.seq)) return

      const focusPane = getHelmFocus()

      if (focusPane !== 'prompt') {
        const composing =
          (focusPane === 'telemetry' && isConsoleComposing()) ||
          (focusPane === 'lanes' && isMinervaComposing())
        if (composing) {
          const isConsole = focusPane === 'telemetry'
          event.stopImmediatePropagation()
          if (key.escape) {
            if (isConsole) {
              if (!consoleAbortAsk()) exitConsoleCompose()
            } else {
              if (!minervaAbortAsk()) exitMinervaCompose()
            }
            return
          }
          if (key.tab) {
            if (isConsole) exitConsoleCompose()
            else exitMinervaCompose()
            setHelmFocus(nextHelmPane(focusPane))
            return
          }
          if (key.return) {
            if (isConsole) {
              const buffered = getConsoleBuffer()
              if (buffered.trim() !== '') {
                const context = getToolUseContext(
                  messages,
                  [],
                  new AbortController(),
                  mainLoopModel ?? '',
                )
                consoleSubmitBuffer((question, controller) =>
                  runConsoleAsk({
                    question,
                    context,
                    abortController: controller,
                  }),
                )
              }
            } else {
              const buffered = getMinervaBuffer()
              if (buffered.trim() !== '') {
                const originalCwd = getFocusedSessionConnector().workspace().originalCwd
                const interviewRef = currentInterviewRef()
                const sessionContext = [
                  buildMinervaSessionDigest(messages),
                  ...(interviewRef !== null ? [`live interview: ${interviewRef}`] : []),
                ].join('\n')
                minervaSubmitBuffer((message, controller) =>
                  runMinervaMessage(
                    tabulaProjectDir(originalCwd),
                    pathBasename(originalCwd) || 'project',
                    message,
                    { signal: controller.signal, sessionContext, projectPath: originalCwd },
                  ),
                )
              }
            }
            return
          }
          if (key.backspace || rawInput === '\u007f') {
            if (isConsole) consoleBackspace()
            else minervaBackspace()
            return
          }
          if (key.delete) {
            if (isConsole) {
              consoleDeleteForward()
            } else {
              if (getMinervaBuffer() === '') exitMinervaCompose()
              else minervaDeleteForward()
            }
            return
          }
          if (key.leftArrow) {
            if (isConsole) consoleMoveCursor(-1)
            else minervaMoveCursor(-1)
            return
          }
          if (key.rightArrow) {
            if (isConsole) consoleMoveCursor(1)
            else minervaMoveCursor(1)
            return
          }
          if (key.ctrl && rawInput === 'a') {
            if (isConsole) consoleCursorHome()
            else minervaCursorHome()
            return
          }
          if (key.ctrl && rawInput === 'e') {
            if (isConsole) consoleCursorEnd()
            else minervaCursorEnd()
            return
          }
          if (key.ctrl && rawInput === 'k') {
            if (isConsole) consoleKillLine()
            else minervaKillLine()
            return
          }
          if (isConsole && key.ctrl && rawInput === 'w') {
            consoleKillWord()
            return
          }
          if (isConsole && key.ctrl && rawInput === 'l') {
            consoleClear()
            return
          }
          if (isConsole && key.upArrow) {
            consoleHistoryMove(-1)
            return
          }
          if (isConsole && key.downArrow) {
            consoleHistoryMove(1)
            return
          }
          if (
            rawInput !== '' &&
            !key.ctrl &&
            !key.meta &&
            rawInput >= ' '
          ) {
            if (isConsole) consoleInsert(rawInput)
            else minervaInsert(rawInput)
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
        if (
          rawInput !== '' &&
          !key.ctrl &&
          !key.meta &&
          rawInput >= ' ' &&
          !key.tab
        ) {
          const composeCapable =
            (focusPane === 'telemetry' && consoleEnabled()) ||
            (focusPane === 'lanes' && minervaReplEnabled())
          event.stopImmediatePropagation()
          if (composeCapable) {
            if (focusPane === 'telemetry') beginConsoleCompose(rawInput)
            else beginMinervaCompose(rawInput)
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
          text: `option produced “${rawInput}” — run ${TERMINAL_SETUP_COMMAND} to make option send meta`,
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
    [modalOverlayUp, input, cursorOffset, mode, footerSelection, helpOpen, isSearchingHistory, messages, isLoading, speculationActive, appStateStore, mainLoopModel, cockpitActive, getToolUseContext, insertAtCursor, setMode, setHelpOpen, setCursorOffset, setAppState, addNotification, escapeDoublePress, voice.phase],
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
    if (isDeepthinkEnabled()) {
      for (const position of findThinkingTriggerPositions(displayedValue)) {
        for (let at = position.start; at < position.end; at++) {
          spans.push({
            start: at,
            end: at + 1,
            color: (['suggestion', 'permission', 'success'] as const)[(at - position.start) % 3] as keyof Theme,
            priority: 10,
          })
        }
      }
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
    if (isAgentSwarmsEnabled() && teamContext !== undefined) {
      const memberPattern = /(^|\s)@([\w-]+)/g
      for (const match of displayedValue.matchAll(memberPattern)) {
        const name = match[2] as string
        const member = Object.values(teamContext.teammates).find(entry => entry.name === name)
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
  }, [displayedValue, isSearchingHistory, historySearch.historyMatch, historySearch.historyFailedMatch, historySearch.historyQuery, cursorOffset, commands, mcpClients, teamContext])

  const deepthinkPresent =
    isDeepthinkEnabled() && findThinkingTriggerPositions(input).length > 0
  useEffect(() => {
    if (deepthinkPresent) {
      addNotification({
        key: 'deepthink-active',
        text: 'deeper reasoning requested for this turn',
        priority: 'low',
        timeoutMs: 5000,
      })
      return () => removeNotification('deepthink-active')
    }
    removeNotification('deepthink-active')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on presence only
  }, [deepthinkPresent])

  const effortText = getEffortNotificationText(
    effortValue,
    mainLoopModel ?? focusedMainModel,
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
  })
  const banner = useSwarmBanner()
  const borderStyle = composerBorderStyle(rows)
  const nonDefaultModeColor = !isDefaultMode(toolPermissionContext.mode)
    ? ('permission' as keyof Theme)
    : undefined
  const borderColor: keyof Theme =
    mode === 'bash'
      ? 'bashBorder'
      : (nonDefaultModeColor ?? composerBorderRole(input === ''))

  const maxVisibleLines = fullscreen
    ? Math.max(3, Math.floor(rows / 2) - 5)
    : undefined

  const textColumns = columns - 3
  const offsetAtCell = (localCol: number, localRow: number): number => {
    const cursor = Cursor.fromText(input, textColumns, cursorOffset)
    const viewportStart =
      composerViewportStartRef.current ?? cursor.getViewportStartLine(maxVisibleLines)
    return cursor.measuredText.getOffsetFromPosition({
      line: localRow + viewportStart,
      column: localCol,
    })
  }
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
  inputSelectionRangeRef.current = mapSelectionToInputRange
  useEffect(
    () => registerInputSelectionConsumer(() => inputSelectionRangeRef.current()),
    [],
  )
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

  const setOverlayDialog = useSetPromptOverlayDialog
  void setOverlayDialog

  const exitStateChange = useCallback((show: boolean, keyName?: string): void => {
    setExitState({ pending: show, keyName: keyName ?? null })
  }, [])

  const composerViewportStartRef = useRef<number | undefined>(undefined)

  const voiceInputFilter = useCallback((rawInput: string, key: Key): string => {
    if (rawInput !== 'v' || key.ctrl || key.meta) return rawInput
    const live = voiceSnapshot()
    if (live.phase === 'recording' || live.phase === 'transcribing') {
      void toggleVoiceCapture()
      return ''
    }
    if (live.enabled && pendingInput.text() === '' && pendingInput.mode() === 'prompt') {
      void toggleVoiceCapture()
      return ''
    }
    return rawInput
  }, [])
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
        toolUseContext={getToolUseContext(messages, [], new AbortController(), mainLoopModel ?? '')}
      />
    )
  }
  if (showTeamsDialog) {
    const teammateEntries =
      teamContext !== undefined ? Object.values(teamContext.teammates) : []
    const initialTeams =
      teamContext !== undefined
        ? [
            {
              name: teamContext.teamName,
              memberCount: teammateEntries.length,
              runningCount: teammateEntries.length,
              idleCount: 0,
            },
          ]
        : undefined
    return (
      <TeamsDialog
        initialTeams={initialTeams}
        onDone={() => setShowTeamsDialog(false)}
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
  if (overlay === 'model-transition-preview' && transitionConfirm !== null) {
    const held = transitionConfirm
    const effectiveNow = mainLoopModelForSession ?? mainLoopModel ?? focusedMainModel
    return (
      <TransitionPreviewCard
        plan={held.plan}
        targetUsability={usabilityForRoute(held.plan.targetRoute)}
        fromLabel={renderModelName(effectiveNow)}
        toLabel={held.value === null ? 'Default' : renderModelName(held.value)}
        refreshed={held.refreshed}
        onConfirm={() => {
          const verdict = reconfirmTransitionPlan(held.plan, messages)
          if (!verdict.ok) {
            setTransitionConfirm({ ...held, plan: verdict.freshPlan, refreshed: true })
            return
          }
          setTransitionConfirm(null)
          applyModelSelection(held.value)
        }}
        onCancel={() => {
          setTransitionConfirm(null)
          setOverlay(null)
          addNotification({
            key: 'model-switched',
            text: `Kept model as ${renderModelName(effectiveNow)} — switch cancelled at the preview`,
            priority: 'high',
            timeoutMs: 3000,
          })
        }}
      />
    )
  }
  if (overlay === 'model-picker') {
    return (
      <ModelPicker
        initial={mainLoopModelForSession ?? mainLoopModel}
        sessionModel={mainLoopModelForSession}
        onSelect={value => handleModelSelect(value)}
        onCancel={() => setOverlay(null)}
      />
    )
  }
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
  if (overlay === 'cap-offer' && capOffer !== null) {
    const offer = capOffer
    return (
      <CapOfferCard
        trigger={offer.trigger}
        windowName={offer.windowName}
        resetText={offer.resetText}
        targetModel={offer.targetModel}
        homeRoute={offer.homeRoute}
        awayRoute={offer.awayRoute}
        homeUsability={usabilityForRoute(offer.homeRoute)}
        awayUsability={usabilityForRoute(offer.awayRoute)}
        onAccept={() => {
          setCapOffer(null)
          setOverlay(null)
          noteOfferDismissal(offer.key)
          if (offer.direction === 'handoff') {
            const stateNow = appStateStore.getState()
            noteCapHandoff(stateNow.mainLoopModelForSession ?? stateNow.mainLoopModel, offer.homeRoute)
          }
          handleModelSelect(offer.targetModel)
        }}
        onDismiss={() => {
          noteOfferDismissal(offer.key)
          setCapOffer(null)
          setOverlay(null)
        }}
      />
    )
  }

  if (overlay === 'slot-offer' && slotOffer !== null) {
    const offer = slotOffer
    return (
      <SlotOfferCard
        familyName={familyDisplayName(offer.family)}
        fromLabel={offer.fromLabel}
        toLabel={offer.toLabel}
        headroomObserved={offer.headroomObserved}
        resetText={offer.resetText}
        onAccept={() => {
          setSlotOffer(null)
          setOverlay(null)
          const outcome = switchActiveSlot(offer.family)
          const durable = paintSlotSwitchReceipt(outcome)
          addNotification({
            key: 'slot-failover',
            text: durable ? slotSwitchTransient(outcome.receipt) : outcome.receipt,
            priority: 'high',
            timeoutMs: 8000,
          })
        }}
        onDismiss={() => {
          noteOfferDismissal(offer.key)
          setSlotOffer(null)
          setOverlay(null)
        }}
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
    showTeamsDialog ||
    showCommandPalette ||
    showFileOpen ||
    showContentSearch ||
    showBashesDialog !== false ||
    isLocalJSXCommandActive
  const inputFocused =
    footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered && !keyboardOwnedByOverlay
  const showCursor =
    footerSelection === null && !isSearchingHistory && helmOnPrompt && !surfaceCovered && !keyboardOwnedByOverlay
  const vimEnabled = isVimModeEnabled()

  const textInputProps = {
    viewportStartRef: composerViewportStartRef,
    value: input,
    onChange,
    cursorOffset,
    onChangeCursorOffset: setCursorOffset,
    columns: columns - 3,
    inputFilter: voiceInputFilter,
    onSubmit: (value: string) => {
      void submit(value, {})
    },
    onExit,
    onExitMessage: exitStateChange,
    onHistoryUp: () => {
      if (!historyNavAllowed('first')) return
      history.onHistoryUp()
    },
    onHistoryDown: () => {
      if (!historyNavAllowed('last')) return
      if (history.historyIndex === 0) {
        if (footerSelection === null && suggestionsMirrorRef.current.suggestions.length === 0) {
          const manageable = Object.values(appStateStore.getState().tasks).filter(isManageableTask)
          if (manageable.length > 0) {
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
    <Box flexDirection="row">
      <PromptInputModeIndicator
        mode={mode}
        isLoading={isLoading}
        inputEmpty={input === ''}
        viewedAgentName={viewedAgentName}
        viewedAgentColor={viewedAgentColor}
      />
      <Box flexGrow={1} minWidth={0} ref={inputBoxRef} onClick={handleInputBoxClick}>
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
            onSelectionConsumed={() => selectionApi.clearSelection()}
            onBeforeRangeEdit={() => pushAtomic(input, cursorOffset, pastedContents)}
          />
        )}
      </Box>
    </Box>
  )

  const bannerLabel = banner !== null ? truncateToWidth(banner.text, Math.max(0, columns - 6)) : null
  const frame =
    banner !== null && bannerLabel !== null ? (
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

  const capEffectiveModel = mainLoopModelForSession ?? mainLoopModel ?? focusedMainModel
  const capRoute = declaredRouteOf(capEffectiveModel)
  const capNote = capHandoffState()
  const capHomeWindow = capNote !== null ? observedFamilyWindow(capNote.homeFamily) : null
  const capResetText =
    capHomeWindow !== null && capHomeWindow.resetsAtMs !== undefined
      ? formatResetTime(capHomeWindow.resetsAtMs / 1000)
      : undefined
  const capLaneLine =
    capNote !== null && capRoute !== null && capRoute !== capNote.homeFamily
      ? `on the ${capRoute} failover lane · ${renderModelName(capEffectiveModel)}${capHomeWindow !== null && (capHomeWindow.state === 'rejected' || capHomeWindow.state === 'warning') && capResetText !== undefined ? ` · ${providerDisplayName(capNote.homeFamily)} window resets ${capResetText}` : ''} · /model to return`
      : null

  return (
    <Box flexDirection="column">
      <IssueFlagBanner />
      {capLaneLine !== null ? (
        <Box paddingLeft={1}>
          <Text color={AMBER}>{capLaneLine}</Text>
        </Box>
      ) : null}
      {hasSuppressedDialogs ? (
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>Waiting for permission…</Text>
        </Box>
      ) : null}
      {frame}
      <MercurySupercodeKeywordHint value={input} />
      <PromptInputStashNotice hasStash={stash !== undefined} />
      {fullscreen ? (
        <Box>
          <Notifications
            apiKeyStatus={apiKeyStatus}
            debug={debug}
            verbose={verbose}
            messages={messages}
            ideSelection={ideSelection}
            mcpClients={mcpClients}
            isInputWrapped={input.includes('\n')}
            alignStart
          />
        </Box>
      ) : null}
      <PromptInputFooter
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
        ideSelection={ideSelection}
        mcpClients={mcpClients}
        teammateFooterIndex={teammateFooterIndex}
        onOpenTasksDialog={() => setOverlay('tasks-dialog')}
      />
    </Box>
  )
}

const PromptInput = React.memo(PromptInputInner)
export default PromptInput
