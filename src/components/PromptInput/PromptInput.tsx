// The composer. The text is NOT owned here: it lives in the
// pending-input owner and the composer subscribes, so a keystroke re-renders
// this subtree only. Submission runs the ladder (fresh-state guards →
// suggestion acceptance → direct member message → empty guard → completion
// guard → agent-view classification → leader submit). The raw input hook
// owns the ladder — rails compose, the empty-prompt ←//alt-arrow
// funnels, mode/help exits, and the Escape chain. Overlay surfaces replace
// the composer through the early returns, after every hook has run.

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
  capOfferAnswered,
  decideCapAction,
  decideCapReturn,
  decideSlotWallAction,
  liveCapFailoverCandidates,
  liveCapFailoverTarget,
  noteCapHandoff,
  type CapFailoverListedFamily,
  noteCapOfferAnswered,
  noteCapReturn,
  noteCapWindowObserved,
  noteOfferAutoDone,
  noteOfferDismissal,
  noteSlotWallObserved,
  observedFamilyWindow,
  offerAutoDone,
  offerDismissed,
  resolveCapPosture,
  slotWallKey,
} from '../../services/capFailover.js'
import { providerDisplayName } from '../../services/providers/routeLaw.js'
import { slotSeatView, slotSwitchTransient, switchActiveSlot } from '../../services/providers/slotSwitch.js'
import { paintSlotSwitchReceipt } from '../../utils/model/slotSwitchReceipt.js'
import { getOpenaiObservedVersion, openaiLimitWindow, subscribeOpenaiObserved } from '../../services/providers/openai/openaiLimitState.js'
import { getUsageRecordVersion, subscribeUsageRecord } from '../../services/claudeAiLimits.js'
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

// ── contract data ───────────────────────────────────────────────────────────
/** The empty-prompt ← funnel target. */
const MANAGER_COMMAND = '/manager'
/** The empty-prompt alt+←/→ funnel target. */
const SESSION_TAB_COMMAND = '/sessiontab'
/** macOS option-character remediation command. */
const TERMINAL_SETUP_COMMAND = '/terminal-setup'
/** The agent-literal escape prefix. */
const DOUBLED_SLASH = '//'
/** Oversized-input cap. */
const INPUT_TRUNCATION_THRESHOLD = 10_000
/** Undo buffer shape. */
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
  /** Agent-view delivery override; when absent the composer delivers
   * through the task owners directly. */
  onAgentSubmit?: (text: string) => void
}

/** Expand tabs before any value is committed. */
function expandTabs(value: string): string {
  return value.includes('\t') ? value.replaceAll('\t', '    ') : value
}

/** The committed value never carries controls: ANSI/OSC sequences stripped
 *  (the shared strip-ansi owner), then every remaining C0/C1 control except
 *  newline and tab dropped. A raw escape in the buffer would EXECUTE when
 *  the row paints (title writes, 2J clears, OSC 52 clipboard exfil).
 *
 *  The C1 block (U+0080-U+009F) is removed FIRST, before strip-ansi, for two
 *  reasons the C0 pass cannot serve (W6 input-encoding: C1 controls survive
 *  and eat the next character). strip-ansi's CSI branch accepts the 8-bit
 *  CSI introducer U+009B and then consumes a final byte from the operator's
 *  own text, so a pasted C1 introducer swallowed the following letter
 *  silently; removing the C1 controls before strip-ansi runs leaves the
 *  letters intact. And strip-ansi's OSC branch is 7-bit only, so the 8-bit
 *  OSC introducer U+009D (the very "OSC 52 exfil" this comment names) passed
 *  straight through; the C1 pass drops it. C0 and DEL still follow
 *  strip-ansi, because ESC (U+001B) lives in that class and must reach
 *  strip-ansi for its 7-bit sequences to be recognised. */
function stripControls(value: string): string {
  // eslint-disable-next-line no-control-regex -- the control filter is the point
  return stripAnsi(value.replace(/[\u0080-\u009f]/g, '')).replace(
    // eslint-disable-next-line no-control-regex -- the control filter is the point
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    '',
  )
}

/** Test seam: the committed-value control filter, exposed for the field
 *  proof (W6 input-encoding). Not a render path. */
export const __stripControlsForTest = stripControls

// The focused chat's main-model resolution as a subscribed primitive (the
// fallback rung of every effective-model chain in the composer).
const subscribeFocusedComposerModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener))
const getFocusedComposerMainModel = (): string => getFocusedSessionConnector().modelFacts().main

function PromptInputInner(props: PromptInputProps): React.ReactNode {
  // The composer's render mark on the FLUX probe ring (MERCURY_FLUX_PROBE
  // only; off ⇒ no-op): the region-invalidation matrix reads the composer
  // region's rhythm from it — typing moves the composer and nothing else.
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
  // The ONE derived accent-bloom: typed text, the submitted turn and the
  // operator nameplate all paint it (the full accent is identity + caret).
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
  // The viewed task as its stable map entry — never the whole task map, so a
  // per-delta task publish does not re-render the composer.
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
  // The speculation slice is ALWAYS an object ({status:'idle'} when nothing
  // runs) — "active" is the only state the escape/interrupt/typing paths
  // may act on; testing the slice for presence swallowed every Escape.
  const speculationActive = useAppState(
    (s: AppState) =>
      (s as { speculation?: { status?: string } }).speculation?.status === 'active',
  )
  const fullscreen = isFullscreenEnvEnabled()
  // The cockpit truth is the CONTEXT FullscreenLayout provides on its
  // rails-showing branch — app state carries no such member.
  const cockpitActive = useContext(CockpitActiveContext)

  // ── the pending-input subscription ────────────────────────────────
  const editGen = useSyncExternalStore(
    pendingInput.subscribePendingInput,
    pendingInput.editGeneration,
    pendingInput.editGeneration,
  )
  // The main-model rung of the effective chain, from the connector.
  const focusedMainModel = useSyncExternalStore(
    subscribeFocusedComposerModel,
    getFocusedComposerMainModel,
    getFocusedComposerMainModel,
  )
  void editGen
  // Voice input: the capture phase drives `v`/esc in the raw-key ladder;
  // each receipt (a refusal, a cancel, the transcribing family) paints once
  // through the notification queue.
  const voice = useSyncExternalStore(subscribeVoice, voiceSnapshot, voiceSnapshot)
  const voiceReceiptSeqRef = useRef(0)
  useEffect(() => {
    const receipt = voice.receipt
    if (receipt === null || receipt.seq === voiceReceiptSeqRef.current) return
    voiceReceiptSeqRef.current = receipt.seq
    // Immediate on both tones — the receipt answers the key the operator
    // just pressed, so it pre-empts whatever the queue is showing (a
    // command receipt rides the same priority) instead of waiting behind it.
    addNotification({
      key: 'voice-receipt',
      text: receipt.text,
      priority: 'immediate',
      ...(receipt.tone === 'error' ? { color: 'error' as const } : {}),
      timeoutMs: 8000,
    })
  }, [voice.receipt, addNotification])
  // The render-reason probe (MERCURY_FLUX_PROBE only; off ⇒ one boolean
  // check): which prop or store snapshot moved this composer render — the
  // region-invalidation matrix's reader names the parent prop or feed that
  // re-rendered the composer outside typing.
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

  // Cursor is LOCAL state, reported back for debounce-persist.
  const [cursorOffset, setCursorOffsetState] = useState(() => {
    // Boot seeding: restore the durable draft cursor when it matches.
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

  // External text changes snap the cursor to end-of-text (render-time).
  const lastSelfWriteRef = useRef(input)
  /** The in-box selection accessor (selection-aware edits): the terminal
   *  selection mapped to a text range when both endpoints sit inside the
   *  input box. The mapper registers here; null = no active text range. */
  const inputSelectionRangeRef = useRef<() => { start: number; end: number } | null>(
    () => null,
  )
  const inputBoxRef = useRef<DOMElement | null>(null)
  const selectionApi = useSelection()
  /** The box rect the CURRENT selection was made over, captured at the
   *  press (a fresh gesture has an anchor and no focus yet). A bottom-
   *  anchored reflow between the drag and the key — a footer notice landing
   *  or expiring — moves the box one row under the screen-anchored
   *  highlight, and mapping against the LIVE rect then refused the gesture
   *  as "outside" (the one-char-per-⌫ report). The gesture's own frame is
   *  the geometry the operator dragged in. */
  const selectionGestureRectRef = useRef<CachedLayout | null>(null)
  useEffect(
    () =>
      selectionApi.subscribe(() => {
        const state = selectionApi.getState()
        if (!state?.anchor) {
          selectionGestureRectRef.current = null
          return
        }
        // Mid-drag (focus set): keep the press frame's rect.
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

  // ── undo/redo timeline ────────────────────────────────────────────
  const buffer = useInputBuffer({
    maxBufferSize: UNDO_BUFFER_SIZE,
    debounceMs: UNDO_COALESCE_MS,
  })

  // Session switch: clear the timeline when the live session id changes —
  // undo must never restore a previous session's draft into the new one.
  // The check runs unconditionally, with no dependency list.
  const bufferSessionRef = useRef(getFocusedSessionConnector().sessionId())
  if (bufferSessionRef.current !== getFocusedSessionConnector().sessionId()) {
    bufferSessionRef.current = getFocusedSessionConnector().sessionId()
    buffer.clearBuffer();
  }

  // W4 (the one-owner draft store): the hop's CURSOR re-key — once the
  // store's re-keyed draft lands (the projected text IS the entered
  // session's saved draft), restore that draft's saved cursor: the mount
  // boot-seed promoted to the slot swap. The render-time external snap
  // above has already reported end-of-text; this later report supersedes
  // it in the same debounce, so the durable cursor survives the swap.
  // Ref-guarded and dep-free (the bufferSessionRef idiom): one restore per
  // re-point, settled even when the target draft is empty.
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

  // ── mode + help state helpers ────────────────────────────────────────────
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

  // Deferred space after a chip.
  const deferredSpaceArmedRef = useRef(false)

  // The stash hint: peak/current tracking.
  const stashPeakRef = useRef(0)

  // ── overlay surface state ────────────────────────────────────────
  const [overlay, setOverlay] = useState<OverlaySurface>(null)
  // The four composer surfaces the raw-input hard skip names (the
  // quick-open family): each is its own flag.
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

  // ── model selection: the composer pick site ──────────────────────
  // The pick settles through the ONE owner (settleModelSelection), shared
  // with the standalone /model command so the two pickers cannot diverge.
  const [transitionConfirm, setTransitionConfirm] = useState<{
    value: string | null
    plan: TransitionPlan
    refreshed: boolean
  } | null>(null)
  // Cap failover: the offer surface. The two memories the contract pins —
  // dismissals keyed by (direction, status, reset time); automatic handoffs
  // at most once per key — live in the SESSION-SCOPED store
  // (capFailover offerDismissed/offerAutoDone): as component refs they died
  // with every tool-permission unmount and the dismissed card returned for
  // hours (FN-016 R8).
  const [capOffer, setCapOffer] = useState<{
    trigger: 'warning' | 'rejected' | 'reset'
    direction: 'handoff' | 'return'
    windowName: string | null
    resetText: string | null
    targetModel: string
    /** The target's own declared lane — stamped at creation (an offer only
     *  ever lands on a declared lane; the null-guard refuses otherwise). */
    targetRoute: CallModelRoute
    /** The handoff's LIST — every other signed-in family with a row to land
     *  on (offerable first, in sign-in order; the lanes at their own cap
     *  last, marked). Empty on the way home. */
    rows: CapFailoverListedFamily[]
    /** The HOME family — the lane whose window walled (a handoff) or reset
     *  (the way home); any family, the card names it. */
    homeRoute: CallModelRoute
    /** The away side of the move (candidate lane on a handoff, the lane
     *  being left on the way home) — the card's spend line speaks it. */
    awayRoute: CallModelRoute
  } | null>(null)
  // The SLOT rung's own memories ride the same session-scoped
  // store: one offer per wall key, one automatic switch per wall key.
  const [slotOffer, setSlotOffer] = useState<{
    key: string
    family: 'anthropic' | 'openai'
    fromLabel: string
    toLabel: string
    /** The view's own verdict on the offered slot's window (FN-016 R18). */
    headroomObserved: boolean
    resetText: string | null
  } | null>(null)
  const limits = useClaudeAiLimits()
  // The cap-failover effect below reads every family's usage record at
  // render and runs on commits: it follows the records' own change signals
  // (the anthropic record's version, the OpenAI lane's observed version) so
  // a band that lands through a facts read re-runs it at once — on a still
  // screen nothing else would, and the offer waited for a keystroke.
  useSyncExternalStore(subscribeUsageRecord, getUsageRecordVersion, getUsageRecordVersion)
  useSyncExternalStore(subscribeOpenaiObserved, getOpenaiObservedVersion, getOpenaiObservedVersion)

  /** The apply tail: the verdict from the settlement owner → patch + toast. */
  const applyModelSelection = (value: string | null): void => {
    // A daemon-hosted focused chat switches through its connector's model
    // door — the session's OWN settlement owner applies now (idle) or parks
    // the switch for the turn's end (busy) — exactly as the two /model
    // surfaces do. Settling into the screen's state alone left the session
    // running its previous model for every following message while the
    // toast, /config and /status claimed the switch (release-hardening
    // audit rank 23); the composer chip, which reads the session's facts,
    // disagreed at once. The screen-state write below remains the owner for
    // the case that owns it: no daemon-hosted chat.
    const focused = getFocusedSessionConnector()
    if (focused.carrier === 'daemon') {
      const label = value === null ? 'Default' : renderModelName(value)
      setOverlay(null)
      // The from-model is read BEFORE the door applies: the connector
      // updates its facts synchronously on an applied receipt, so a preview
      // taken after compared the destination against itself (an always-
      // empty loss note), and the family change went unnamed — the FN-016
      // R17 class in the composer's own arm; the two /model surfaces read
      // the same fact the same way.
      const effectiveBefore = focused.modelFacts().effective
      // The receipt is the daemon's word (FN-015 rank 50): the toast waits
      // for it, so a refusal is spoken and never painted as a switch.
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
    // The loss summary rides a FRESH preview against the session's effective
    // model in both the queued and applied cases.
    const effectiveFrom = stateNow.mainLoopModelForSession ?? stateNow.mainLoopModel
    const lossNote = transitionPlanSummary(previewForSelection(messages, effectiveFrom, value))
    if (settled.kind === 'queued') {
      setAppState(prev => ({ ...prev, ...settled.patch }))
      addNotification({
        key: 'model-switched',
        // Paired with the boundary's applied receipt (REPL model-transition
        // effect): each invalidates the other, or the immediate applied
        // notice re-queues this one and the settled screen shows a stale
        // "switch queued" after the receipt expires.
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

  /** The full pick path: the action rows, the needs-choice gate, then the
   *  apply tail. */
  const handleModelSelect = (value: string | null): void => {
    // The provider sign-in action rows: dispatch the connect flow instead of
    // writing a model (contract data: the /logins sign-in home). The /model
    // command surface owns the richer catalogue-retry branch.
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
    // The key-lane attach rows: route to the
    // lane's key-entry surface; the unconfigurable compat slot states its
    // config route instead.
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
        // The /logins card carries each family's leg — route there with the
        // family pre-focused.
        requestCommandDispatch(`/logins ${keyLane}`)
        return
      }
    }
    // The needs-choice gate: the settlement probe is pure — it writes
    // nothing. A pick that would actually change the model and whose frozen
    // plan carries meaningful loss parks at the preview card first.
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

  // Cap failover: live limit status × posture → none / offer / automatic
  // handoff. The decision block never settles anything itself; the offer's
  // accept re-enters the full selection path, the unattended handoff calls
  // the apply tail directly. Runs every commit — the per-key memories and
  // the overlay guard keep it idempotent.
  useEffect(() => {
    const posture = resolveCapPosture()
    // ── the SLOT rung — BEFORE any cross-family move, at EVERY
    // posture: a walled ACTIVE slot whose family holds a second signed-in
    // slot with headroom asks in one key (postures off/offer) or switches
    // unattended (auto; the wall row's appendix is the transcript receipt,
    // this notification + the slot state the rest). The cheapest move first
    // — same family, same session, nothing signs out.
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
          // The wall key is the family and the walled seat — never the
          // stated reset moment (a re-observed wall re-states it by seconds
          // and would re-offer an answered wall); a clear observation ends
          // the wall and re-arms the rung for the next one.
          const slotKey = slotWallKey(family, view.active ?? '')
          noteSlotWallObserved(family, view.active ?? '', activeWall.walled)
          if (action.kind === 'offer') {
            // NEVER over a live turn (FN-016 R7): the card replaces the
            // composer and takes the keyboard — mid-stream its Escape
            // doubled as the turn interrupt and its instant Enter flipped
            // the account under a type-ahead. Deferral is not dismissal:
            // no memory is consumed, the wall key is stable, and this
            // effect re-runs at the turn boundary, so the boundary
            // re-offer is the same wall.
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
              // The rung TOOK the screen — the ladder rests until the
              // card is answered.
              return
            }
            // Dismissed (or overlay-suppressed): the ladder keeps its next
            // rung — one Escape on the slot card must not close the
            // cross-family offer for the rest of the window (FN-016 R19);
            // the cross-family decision below now speaks for this wall.
          } else if (!offerAutoDone(slotKey)) {
            // auto-switch: at most once per wall key; receipted in words.
            noteOfferAutoDone(slotKey)
            const outcome = switchActiveSlot(family)
            // THE RECEIPT (FN-016 R20): one durable transcript row through
            // the display-row door; the footer keeps the first clause, and
            // the whole receipt only where no door exists.
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
    // ── the CROSS-FAMILY rung, family-neutral: HOME is the family the
    // session runs on (or left); its OWN observed window decides; the
    // candidates are every other signed-in usable family (sign-in recency
    // first, no favourite); the way home needs the home window OBSERVED
    // reset and the home credential still signed in.
    const modelFactsNow = getFocusedSessionConnector().modelFacts()
    const effective =
      modelFactsNow.sessionPin ?? modelFactsNow.setting ?? modelFactsNow.main
    const liveRoute = declaredRouteOf(effective)
    const noted = capHandoffState()
    // Self-heal: an abandoned or manually reversed handoff clears its note
    // once the live route is home again.
    if (noted !== null && liveRoute === noted.homeFamily) {
      noteCapReturn()
      return
    }
    const onFailoverLane = noted !== null && liveRoute !== noted.homeFamily
    const homeFamily: string | null = noted !== null && onFailoverLane ? noted.homeFamily : liveRoute
    // An unrecognised id names no family: no window to watch, no card.
    if (homeFamily === null) return
    // The home credential's verdict is read only while parked away (the
    // composed usability walks every family's store — not a per-keystroke
    // cost for the common, at-home case).
    const homeUsability = onFailoverLane ? usabilityForRoute(homeFamily as CallModelRoute) : null
    // No home to return to: the home credential LEFT while the session was
    // parked away (a board sign-out, /logout) — the handoff is over, and
    // the session simply runs where it is. Never a return card.
    if (homeUsability !== null && homeUsability.credential === 'none') {
      noteCapReturn()
      return
    }
    // The ONE per-family window resolver: 'unknown' (nothing observed, a
    // credential that just changed) is a state — it never reads as
    // headroom for a handoff, nor as a reset for the way home.
    // The window is read FOR the seat that runs (or ran) on the home family:
    // on the first-party family the per-model weekly pool that model binds
    // is the window that matters (a Fable seat at 87% of the Fable pool is
    // approaching its cap while the shared 5h/7d read low).
    const window = observedFamilyWindow(homeFamily, undefined, {
      model: onFailoverLane ? (noted?.homeModel ?? null) : effective,
    })
    // The armed-state re-arm runs EVERY commit (before the none-return): a
    // real reset re-arms the handoff, a window that caps again re-arms the
    // return. Keeps the answered latch stable across the state/reset jitter
    // that used to mint a fresh key and re-open the card forever.
    noteCapWindowObserved(homeFamily, window.state)
    const action =
      onFailoverLane && homeUsability !== null
        ? decideCapReturn(posture, { window: window.state, credentialUsable: homeUsability.usable }, true)
        : decideCapAction(posture, window.state)
    if (action.kind === 'none') return
    const direction: 'handoff' | 'return' = onFailoverLane ? 'return' : 'handoff'
    const windowName = window.windowName ?? null
    const resetText =
      window.resetsAtMs !== undefined ? (formatResetTime(window.resetsAtMs / 1000) ?? null) : null
    const homeName = providerDisplayName(homeFamily)
    if (action.kind === 'offer') {
      // The offer stays disarmed once ANSWERED for this (direction, family)
      // until the window materially changes — never re-fired by a state or
      // reset-moment jitter within the same wall.
      if (capOfferAnswered(direction, homeFamily)) return
      // The offer replaces the input only while waiting for its keypress —
      // never over another open surface.
      if (modalOverlayUp) return
      let target: string | null
      let rows: CapFailoverListedFamily[] = []
      if (direction === 'return') {
        target = noted?.homeModel ?? getFocusedSessionConnector().modelFacts().main
      } else {
        // The neutral candidate law: every OTHER signed-in family with a row
        // to land on, from the one owner — the offerable lanes in sign-in
        // order (the first is the default highlight), the lanes at their own
        // cap after them, marked. No offerable lane ⇒ no card.
        const set = liveCapFailoverCandidates(homeFamily)
        target = set.candidates[0]?.model ?? null
        rows = set.listed
      }
      if (target === null) return
      // An offer only ever lands on (and leaves) a DECLARED lane: an
      // unrecognised id names no lane to offer, so no card is built.
      const targetRoute = declaredRouteOf(target)
      if (targetRoute === null) return
      const awayRouteResolved = direction === 'return' ? liveRoute : targetRoute
      if (awayRouteResolved === null) return
      setCapOffer({
        trigger: action.trigger,
        direction,
        windowName,
        resetText,
        targetModel: target,
        targetRoute,
        rows,
        homeRoute: homeFamily as CallModelRoute,
        awayRoute: awayRouteResolved,
      })
      setOverlay('cap-offer')
      return
    }
    // Automatic handoff/return: at most once per wall for this (direction,
    // family); the same stable latch the offer answers on — no preview card
    // can interrupt it, and no jitter re-fires it.
    if (capOfferAnswered(direction, homeFamily)) return
    noteCapOfferAnswered(direction, homeFamily)
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

  // ── the viewed agent ─────────────────────────────────────────────────────
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

  // ── per-destination drafts ────────────────────────────────────────
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

  // ── prompt-empty publish + typing beacon ──────────────────────────
  useEffect(() => {
    setPromptEmpty(input.trim() === '')
  }, [input])

  // ── the change handler ────────────────────────────────────────────
  const suggestionApi = usePromptSuggestion({
    inputValue: input,
    isAssistantResponding: isLoading,
  })
  // The shown stamp is recorded while the suggestion is actually
  // displayable (it paints as the composer placeholder, below); acceptance
  // requires a positive stamp.
  const suggestionDisplayable =
    suggestionApi.suggestion !== null && mode === 'prompt' && !viewedAgentName
  const markSuggestionShown = suggestionApi.markShown
  useEffect(() => {
    if (suggestionDisplayable) markSuggestionShown()
  }, [suggestionDisplayable, markSuggestionShown])
  const onChange = useCallback(
    (raw: string): void => {
      // Help toggle: a change whose ENTIRE value is one '?' toggles help and
      // never enters the text.
      if (raw === '?' && input === '') {
        setHelpOpen(!helpOpen)
        return
      }
      if (helpOpen) setHelpOpen(false)

      let value = expandTabs(stripControls(raw))

      // Deferred space after a chip: a printable non-whitespace keystroke
      // right after a chip gets one space ahead of it.
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

      // Bash-mode entry.
      if (mode === 'prompt') {
        if (
          value.length === input.length + 1 &&
          value.startsWith('!') &&
          value.slice(1) === input
        ) {
          // Single-character '!' insertion at offset 0: switch, insert
          // nothing — and write the unchanged draft through the one owner
          // (pendingInput + the self-write mark) BEFORE the mode flips, or
          // the render-time reconciliation re-imports the retained '!' and
          // appends it to the command's END: '!echo ok' painted '! echo ok!'
          // and ran 'echo ok!' (TASK-014 w2-f13-02, S1 — measured on the
          // box; every sibling branch of this handler already writes
          // through the owner).
          pendingInput.edit(input)
          lastSelfWriteRef.current = input
          setMode('bash')
          return
        }
        if (
          input === '' &&
          value.length > 1 &&
          // A multi-line burst (a non-bracketed paste) is content, not a
          // mode chord — same law as handleTextPaste's bang-paste guard.
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

      // Typing side effects: dismiss the stash hint, abort a pending
      // suggestion + speculation, clear the footer pill selection.
      removeNotification('stash-hint')
      if (speculationActive) abortSpeculation(setAppState)
      if (footerSelection !== null) {
        setAppState(prev => ({ ...prev, footerSelection: null }))
      }

      buffer.pushToBuffer(input, cursorOffset, pastedContents)
      pendingInput.edit(value)
      lastSelfWriteRef.current = value

      // Stash-hint tracking: gradual clear of substantial input.
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

      // Orphan pruning: read the LIVE shared text, functional update.
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

  // Oversized-input truncation (effect-only hook).
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

  // ── pastes and images ─────────────────────────────────────────────
  const nextPasteIdRef = useRef<number | null>(null)
  if (nextPasteIdRef.current === null) {
    // Seeded once from the transcript so a resumed session cannot collide.
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
    // The transcript seed above cannot see ids a history recall restored
    // into the LIVE draft (a recalled chip rides prompt history, not this
    // session's messages) — allocation scans the live draft too, or the
    // recalled chip's id is re-minted: its stored body is overwritten and
    // one body sends under two references.
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
    // The insertion is one transaction: the pre-insert draft is recorded
    // whole, and an active in-box selection is REPLACED by the insertion.
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
      // An armed deferred space emits ahead of the next chip.
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
      // THE ONE normalisation rule (input-core/composer-document): ANSI/OSC
      // stripped, CRLF or a lone CR collapsed to one newline in the same pass
      // (two passes double-space Windows clipboards), tabs widened; residual
      // controls dropped on top.
      const text = stripControls(normalizePastedInput(raw))
      const lineCount = (text.match(/\n/g) ?? []).length + 1
      // A paste is CONTENT: only a short single-line `!command` may engage
      // shell mode. A multi-line or oversized body starting with '!' takes
      // the normal chip path below with the '!' kept in the body — the
      // unguarded branch flooded shell mode with the whole paste.
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

  // IDE at-mention: one atomic reference insert.
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

  // ── the imperative insert seam ────────────────────────────────────
  // The ref is (re)assigned every render so it always closes over the live
  // handlers; the flush + null ride an UNMOUNT-ONLY effect — a per-render
  // cleanup here would flush the durable draft on every keystroke and
  // defeat the 400 ms debounce.
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

  // ── completion seam ───────────────────────────────────────────────
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
      // Selection goes to the module store OUTSIDE any React updater.
      setSelectedSuggestionStore(next.selectedSuggestion)
      // Component state commits only when array or hint changed by identity.
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

  // ── history + reverse search ──────────────────────────────────────
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

  // ── submission ────────────────────────────────────────────────────
  /** Up/Down recall history only when at most one completion is showing and
   * the cursor sits on the first/last line; no newline ⇒ both hold. */
  const historyNavAllowed = (edge: 'first' | 'last'): boolean => {
    if (suggestionsMirrorRef.current.suggestions.length > 1) return false
    const firstNewline = input.indexOf('\n')
    if (firstNewline === -1) return true
    if (edge === 'first') return cursorOffset <= firstNewline
    return cursorOffset > input.lastIndexOf('\n')
  }
  // One typed submission per synchronous input dispatch: two return atoms
  // in ONE stdin chunk (a held key's coalesced repeat) dispatch back-to-back
  // while the draft clear still sits behind the REPL's first await — the
  // second Enter re-read the same draft, the first reservation made it
  // "busy", and the duplicate was queued behind it (two identical rows).
  // Released on the microtask boundary, so the next chunk is never fenced.
  const sameDispatchSubmitRef = useRef(false)
  const submit = useCallback(
    async (
      raw: string,
      options: { fromKeybinding?: boolean; isSlashPick?: boolean },
    ): Promise<void> => {
      const value = raw.replace(/\s+$/, '')
      const fresh = appStateStore.getState() as AppState

      // 1 · fresh-state guards. A pill that is selected AND still visible
      // owns Enter (its own open action fires); a pill whose source has
      // gone away no longer blocks the submit. Every pill in the footer
      // vocabulary is tested, not tasks alone.
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

      // 2 · prompt-suggestion acceptance: only a SEEN suggestion accepts
      // (shownAt > 0 — an unseen one must not ride an empty Enter), and
      // acceptance substitutes the value WITHOUT returning: the ladder
      // continues so the record resets and the guards below still run.
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

      // 2b · the same-dispatch fence (typed submissions only).
      if (!options.fromKeybinding) {
        if (sameDispatchSubmitRef.current) return
        sameDispatchSubmitRef.current = true
        queueMicrotask(() => {
          sameDispatchSubmitRef.current = false
        })
      }

      // 3 · direct member message — through the one parse/deliver owner
      // (the contract sender is the literal 'user').
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
            // clearForSubmit stages the text and deletes the durable draft;
            // the LIVE draft is emptied here, or the sent line stays in the
            // composer for a second Enter to send again.
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
              // A second message's receipt replaces the first (a same-key
              // re-add without fold is dropped: no receipt for the send).
              fold: (_accumulated, incoming) => incoming,
            })
            return
          }
          // Unknown recipient / no team: fall through to normal submit.
        }
      }

      // 4 · empty guard.
      if (submitted === '' && !hasImages) return

      // 4b · dangling-reference guard (law 3: honest failure over silent
      // loss). A recalled or restored chip whose body is absent — an aged-out
      // history paste (resolveRecord drops unrecoverable hash bodies
      // silently), an image recalled from history (images never enter it) —
      // would ship as a bare placeholder: expandPastedTextRefs passes
      // unresolvable references through and the model receives the
      // placeholder instead of the operator's content. Refuse with the
      // exact reference named; the draft stays put for repair.
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

      // 5 · open completion guard. A slash-command submission passes: the
      // refusal is for unresolved non-command menus only; directory
      // completions are exempt because Tab, not Enter, completes them.
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

      // 6 · suggestion outcome + stash hint teardown. A speculation accept
      // in flight suppresses the reset — it would tear the speculation down
      // before the submit below can consume it.
      suggestionApi.logOutcomeAtSubmission(
        submitted,
        speculationAccept !== undefined ? { skipReset: true } : undefined,
      )
      removeNotification('stash-hint')

      // 7 · agent-view routing.
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
            // Queueing feeds the agent's model input and leaves the display
            // untouched — append the typed line so it paints immediately.
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
            // Never delivered; the draft is PRESERVED.
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
        // As in step 3: the delivered line must leave the live draft.
        pendingInput.clearForSubmit(submitted)
        pendingInput.edit('')
        lastSelfWriteRef.current = ''
        buffer.clearBuffer()
        history.resetHistory()
        setCursorOffset(0)
        return
      }

      // 8 · leader submission.
      await onSubmit(submitted, helpers, speculationAccept, {
        fromKeybinding: options.fromKeybinding === true,
      })
    },
    [appStateStore, suggestionApi, teamContext, commands, helpers, buffer, history, onSubmit, onAgentSubmit, setAppState, setCursorOffset, addNotification, removeNotification],
  )

  // ── the dispatch drain ────────────────────────────────────────────
  const helmVersion = useSyncExternalStore(
    subscribeHelmFocus,
    getHelmVersion,
    getHelmVersion,
  )
  // The covered-composer fence (the useKeybinding hooks carry this check
  // themselves; the raw ladder and the text buffer's focus prop must carry
  // it too): while another route surface owns the frame — the Concourse,
  // Boot Settings — the parked REPL's composer is deaf, or every keystroke
  // typed on the covering surface ALSO lands in this buffer.
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
          // The view swap moves the operator's attention to the composer:
          // focus returns home, or the next keystrokes fall into the rail's
          // compose line instead of the prompt.
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

  // ── keybindings (Chat context) ───────────────────────────────────
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
      // The editor hands back `content` (EditorResult) — the composer rewrite
      // read a `text` field behind a cast, so the commit below was
      // unreachable and every external edit was silently discarded (CI-01).
      const result = await editPromptInEditor(expanded)
      if (result.error) {
        addNotification({
          key: 'external-editor-error',
          text: `external editor failed: ${result.error}`,
          color: 'warning',
          priority: 'high',
        })
      } else if (typeof result.content === 'string' && result.content !== expanded) {
        // The external-editor return is one ATOMIC edit — one undo restores
        // the pre-editor draft whole.
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
    // The PREPARED context: cyclePermissionMode runs the transition side
    // effects (plan entry stashes prePlanMode; plan exit clears + marks
    // exited; auto entry arms the classifier + strips dangerous
    // permissions; auto exit restores them).
    const { nextMode, context: nextContext } = cyclePermissionMode(
      toolPermissionContext,
      teamContext,
    )
    if (nextMode === 'strategy') {
      saveGlobalConfig(config => ({ ...config, lastPlanModeUse: Date.now() }))
    }
    // The transition owner returns the PREPARED context and the next mode
    // separately (it never writes the mode itself). The store setter ADOPTS
    // the incoming mode by default — user-initiated changes land; only
    // worker write-backs pass preserveMode to keep the previous mode.
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
  // The quick-open family: one opener each, inactive beneath any overlay.
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

  // footer pill navigation (Footer context, active while selected).
  // The selected teammate pill is composer-LOCAL state, threaded down to
  // BackgroundTaskStatus (index 0 = the leader pill).
  const [teammateFooterIndex, setTeammateFooterIndex] = useState(0)
  // A count, not the map: the pill navigation re-renders only when the
  // number of running teammates changes.
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

  // ── the raw input ladder ─────────────────────────────────────────
  const escapeDoublePress = useDoublePress(
    () => {},
    () => {
      onShowMessageSelector()
    },
  )
  // The double-esc DRAFT CLEAR lives at its one owner — useTextInput's
  // escape handler (the ruled 3-second window);
  // the ladder below only keeps the empty-composer selector arm.
  const handleRawKey = useCallback(
    (
      rawInput: string,
      key: Key,
      event: { stopImmediatePropagation: () => void; seq?: number },
    ): void => {
      // 1 · hard skip under a modal overlay or composer surface, and while
      // another route surface covers the REPL (read live, like the
      // useKeybinding hooks' own covered check — never captured at render).
      if (modalOverlayUp) return
      if (currentSurfaceRoute().kind !== 'repl') return
      // 1b · SR-022 at the revealed root's own gate: an event decoded at or
      // before the transition that revealed this surface belongs to the
      // PRIOR generation and is declined whole — the board's confirming ↵
      // (and anything queued behind it) must never submit, type, or steer
      // here. The route commit's watermark already breaks these at the
      // emitter; this gate is the ladder's own spelling of the law and
      // holds even for a dispatch lane without the watermark.
      if (event.seq !== undefined && isPriorGenerationInput(event.seq)) return

      const focusPane = getHelmFocus()

      // 2 · rail focus: the compose-capable panes own navigation keys.
      if (focusPane !== 'prompt') {
        const composing =
          (focusPane === 'telemetry' && isConsoleComposing()) ||
          (focusPane === 'lanes' && isMinervaComposing())
        if (composing) {
          const isConsole = focusPane === 'telemetry'
          event.stopImmediatePropagation()
          if (key.escape) {
            // Symmetric esc law for both compose panes: a PENDING exchange
            // aborts first; only a quiet pane exits compose.
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
                // The dir is the TABULA STORE dir for this project (the owner
                // writes meta/journal under it), never the project tree itself.
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
        // Outside compose: the rail keyboard journey rides the four landed
        // owners — Escape home, Tab cycles panes, ↑↓ move within the pane,
        // ↵ activates the current row through the SAME activation switch
        // the click bus drains into. Arrows/Escape/Tab act immediately;
        // only activation waits out the entry-settle interval.
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
          // Row activation waits for the entry-settle interval: a rapid run
          // of keys that carried focus into the rail must not also trigger
          // whichever row sits under the cursor.
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

      // 2b · voice input: esc during a take cancels it — the take is
      // dropped, nothing is sent. (The `v` press-to-start / press-to-stop
      // lives in the text input's filter, voiceInputFilter below, where the
      // keystroke can be swallowed before it types.)
      if (voice.phase === 'recording' && key.escape) {
        event.stopImmediatePropagation()
        cancelVoiceCapture()
        return
      }

      // 3 · Tab on an empty plain prompt moves focus into the rails.
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

      // 4 · alt+←/→ on an empty plain prompt: the session-tab funnel.
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

      // 5 · plain ← on an empty plain prompt opens the manager surface —
      // through the classified funnel, never the dispatch queue.
      if (emptyPlainPrompt && key.leftArrow && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        void submitRef.current(MANAGER_COMMAND, { fromKeybinding: true })
        return
      }

      // 6 · macOS option-character detection (the character still types).
      if (getPlatform() === 'macos' && rawInput.length === 1 && 'åß∂ƒ©˙∆˚¬…æ∑'.includes(rawInput)) {
        addNotification({
          key: 'option-meta-hint',
          text: `option produced “${rawInput}” — run ${TERMINAL_SETUP_COMMAND} to make option send meta`,
          priority: 'low',
          timeoutMs: 5000,
        })
        // no return: the character still types.
      }

      // 7 · type-to-exit for footer pills.
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

      // 8 · mode/help exits at cursor 0 (no return — escape continues).
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

      // 9 · the Escape ladder.
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

      // 10 · Enter while help is open closes it.
      if (key.return && helpOpen) {
        setHelpOpen(false)
      }
    },
    [modalOverlayUp, input, cursorOffset, mode, footerSelection, helpOpen, isSearchingHistory, messages, isLoading, speculationActive, appStateStore, mainLoopModel, cockpitActive, getToolUseContext, insertAtCursor, setMode, setHelpOpen, setCursorOffset, setAppState, addNotification, escapeDoublePress, voice.phase],
  )
  useInput((rawInput, key, event) => {
    handleRawKey(rawInput, key, event)
  })

  // Direct submit registration (chord completion only) is covered by the
  // text input's own onSubmit; the registry entry is intentionally absent
  // from the hook path so Enter's propagation survives for completion.

  // ── highlights ────────────────────────────────────────────────────
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

  // Deepthink turn-scope toast.
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

  // the effort toast owns CHANGES only — the standing fact belongs
  // to the statusbar chip. First render arms a baseline silently; a genuine
  // change toasts with a fold that replaces the text and restarts the
  // timeout (a bare same-key re-add is dropped while the previous toast is
  // still current, which lost the real value whenever an effort pin landed
  // after first render); an unavailable effort text removes the toast.
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

  // ── placeholder + banner + frame ─────────────────────────────────────────
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

  // ── selection-aware edits + click-to-position ("Selection-aware
  // edits"): the terminal selection becomes a TEXT RANGE only when both
  // endpoints sit inside the input box's committed rectangle; the mapping
  // from screen cells to offsets rides the same wrap model as
  // click-to-position, offset by the box rect and the viewport start line.
  // Selection cells are end-inclusive, the text range end-exclusive.
  const textColumns = columns - 3
  const offsetAtCell = (localCol: number, localRow: number): number => {
    const cursor = Cursor.fromText(input, textColumns, cursorOffset)
    // D2: the PAINTED window (the banded start the editor just rendered
    // with), never an independent centred re-derivation — a click must hit
    // what is painted NOW.
    const viewportStart =
      composerViewportStartRef.current ?? cursor.getViewportStartLine(maxVisibleLines)
    return cursor.measuredText.getOffsetFromPosition({
      line: localRow + viewportStart,
      column: localCol,
    })
  }
  const mapSelectionToInputRange = (): { start: number; end: number } | null => {
    // Reverse search displays the history MATCH, not the input: a drag over
    // it must not splice the input by those cells.
    if (isSearchingHistory) return null
    const state = selectionApi.getState()
    if (!state || !state.anchor || !state.focus) return null
    const box = inputBoxRef.current
    // The rect of the frame the gesture was made in (see the subscription
    // above); the live rect only when no press was observed.
    const rect = selectionGestureRectRef.current ?? (box ? nodeCache.get(box) : undefined)
    // The geometry census (MERCURY_SUBMIT_TRACE, shape-only: cells and
    // offsets, never text): with a selection on screen, every exit names
    // its step — the drag-then-⌫ one-char report localises in one run.
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
    // Normalise row-major to start ≤ end.
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
  /** Quick-open insertions: one atomic edit at the cursor, never a submit. */
  const insertTextAtCursor = (text: string): void => {
    insertAtCursor(text, { atomic: true })
  }
  const handleInputBoxClick = (event: { localCol: number; localRow: number }): void => {
    // Disabled while history search is active (the displayed string is
    // not the input) and when the input is empty.
    if (isSearchingHistory || input === '') return
    setCursorOffset(
      Math.max(0, Math.min(input.length, offsetAtCell(event.localCol, event.localRow))),
    )
  }

  // ── fullscreen dialog-slot publication (before the returns) ────────
  const setOverlayDialog = useSetPromptOverlayDialog
  void setOverlayDialog

  const exitStateChange = useCallback((show: boolean, keyName?: string): void => {
    setExitState({ pending: show, keyName: keyName ?? null })
  }, [])

  // D2 (CI-05): the composer's banded viewport start, shared
  // between the painted editor and the click/selection mapping below —
  // paint and hit-testing must read ONE window. Declared HERE, above the
  // overlay early-returns: a hook below them runs only on the no-overlay
  // render, and that inter-render hook-count change is the React #300
  // session-kill class (the "after every hook" law this section is named
  // for — prove-composer-hook-order pins it).
  const composerViewportStartRef = useRef<number | undefined>(undefined)

  // Voice input rides the text input's own filter — the one place a
  // keystroke can be swallowed before it types (the text input subscribes
  // ahead of the raw-key ladder). A terminal sees no key-up, so `v` is
  // press-to-start / press-to-stop: with /speak on, `v` in an empty plain
  // composer starts a take; while one runs (or its transcription is in
  // flight) `v` stops it — neither types. Read LIVE, never the render's
  // snapshot: the second press must see the first press's phase. With
  // /speak off, v is the letter v — even while the last take's
  // transcription is still in flight (a running take is always stoppable,
  // and /speak off drops it).
  const voiceInputFilter = useCallback((rawInput: string, key: Key): string => {
    if (rawInput !== 'v' || key.ctrl || key.meta) return rawInput
    const live = voiceSnapshot()
    if (live.phase === 'recording' || (live.phase === 'transcribing' && live.enabled)) {
      void toggleVoiceCapture()
      return ''
    }
    if (live.enabled && pendingInput.text() === '' && pendingInput.mode() === 'prompt') {
      void toggleVoiceCapture()
      return ''
    }
    return rawInput
  }, [])
  // ── composer-scoped overlays (after every hook) ──────────────────
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
    // The initial team list is the caller's (derived from application
    // state) so the dialog performs no discovery of its own; the counts it
    // does not consult stay honest to what state knows.
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
        // The hub rows: quick-open surfaces run a callback (never insert).
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
          // Stale-safe: re-derive the current keys; regenerate and
          // re-present on drift, settle only on a clean verdict.
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
        // The focus belongs to the EFFECTIVE model (session pin first — the
        // Drive-12 channel) — `mainLoopModel` alone focused a stale base
        // while the session ran something else.
        initial={mainLoopModelForSession ?? mainLoopModel}
        // The strategy-mode banner keys on the SESSION OVERRIDE — passing the
        // base model here claimed "set by strategy mode" for any plainly
        // configured model (a false provenance line).
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
          // Coloured when on, dim when off.
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
        rows={offer.direction === 'handoff' ? offer.rows : undefined}
        onAccept={chosen => {
          setCapOffer(null)
          setOverlay(null)
          // An answered card never re-fires for the same wall: accept
          // latches this (direction, family) exactly like a dismissal,
          // whatever the selection path then decides (applied, previewed,
          // refused — the apply tail's own footer line carries a refusal's
          // reason). Keyed on the stable facts, so a state or reset-moment
          // jitter within the wall can never re-open the card (the loop the
          // operator hit: confirm → preview → confirm → offer, forever).
          noteCapOfferAnswered(offer.direction, offer.homeRoute)
          if (offer.direction === 'handoff') {
            // Record the way home at accept time — the SEAT's own effective
            // model (the connector's facts), never the screen's ambient
            // state: the return decision reads the home window FOR this
            // model (the weekly pool a Fable seat binds), and a home recorded
            // as null read the shared windows alone and offered a false
            // "window reset" the moment the switch landed. An abandoned
            // preview self-heals (the route stays home → the note clears).
            const seat = getFocusedSessionConnector().modelFacts()
            noteCapHandoff(seat.sessionPin ?? seat.setting ?? seat.effective, offer.homeRoute)
          }
          // Accept re-enters the FULL selection path — the preview gate
          // included — for the row the operator CHOSE (the highlighted lane
          // of the list; the one target otherwise).
          handleModelSelect(chosen.model)
        }}
        onDismiss={() => {
          noteCapOfferAnswered(offer.direction, offer.homeRoute)
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
          // The one switch owner flips the seat and words the receipt; no
          // model changes hands — the next turn rides the other slot.
          const outcome = switchActiveSlot(offer.family)
          // THE RECEIPT (FN-016 R20): the same durable row as the auto arm;
          // the footer keeps the first clause.
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

  // ── render ───────────────────────────────────────────────────────────────
  const searchField = isSearchingHistory ? (
    <HistorySearchInput
      value={historySearch.historyQuery}
      onChange={historySearch.setHistoryQuery}
      historyFailedMatch={historySearch.historyFailedMatch}
    />
  ) : undefined
  // Open completions do NOT unfocus the buffer (typing keeps narrowing the
  // menu); they only suppress up/down cursor movement, below. A selected
  // pill, history search, and a rail holding helm focus are the states that
  // take the keyboard. The helm gate is the helmFocus.ts contract ("its
  // text-buffer focus prop gates off helm focus"): the buffer's listener
  // registers child-first, AHEAD of the rail arm, so the rail arm's
  // stopImmediatePropagation can never fence it — without this gate every
  // rail/compose keystroke ALSO landed in the main buffer (the tab-then-type
  // double-paint leak). Reactive via the helmVersion subscription above.
  // The covered fence rides the same principle one level up: a route
  // surface over the REPL (Concourse, Boot Settings) takes the keyboard
  // whole — reactive via the surfaceRoute subscription above.
  const helmOnPrompt = getHelmFocus() === 'prompt'
  // THE OVERLAY INPUT SCOPE (the credential double-delivery class): while an
  // overlay owns the keyboard — a dialog command's surface (a hidden key
  // entry among them), the palette, file-open, content search, the bashes
  // dialog — NOT ONE BYTE reaches the composer: the same keystrokes once
  // fed a /router key entry AND the composer beneath it, so the storing ↵
  // also submitted and the secret painted as a user row, persisted in the
  // transcript and went to the provider as chat content. The keybinding
  // hooks were already gated on the overlay union; the text input itself is
  // gated here. hasSuppressedDialogs stays OUT of this gate deliberately —
  // suppression exists because the operator IS typing (typing wins).
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
    // The REAL exit (REPL's handleExit — worktree flow or the exit command):
    // the second chord press inside the exit window closes Mercury. This was
    // a severed loop (onExit discarded) — the notice armed but the double press
    // did nothing.
    onExit,
    onExitMessage: exitStateChange,
    onHistoryUp: () => {
      // With more than one completion showing the menu's own
      // previous-item binding owns ↑; off the first line ↑ is cursor motion.
      if (!historyNavAllowed('first')) return
      history.onHistoryUp()
    },
    onHistoryDown: () => {
      if (!historyNavAllowed('last')) return
      // Down runs OFF THE END of history (index 0 = the live input)
      // with footer pills present → focus moves into the footer at the
      // first pill; the first such landing persists a seen-flag so the
      // one-time hint stops appearing. Never while a menu is open.
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
    // The typed text wears the derived bloom — the SAME tint the submitted
    // turn and the operator nameplate paint, so a submit never recolours it.
    userTextColor: composerBloom,
    disableCursorMovementForUpDownKeys:
      footerSelection !== null || suggestionsMirrorRef.current.suggestions.length > 0,
    // One Enter owner while a SELF-SUBMITTING menu is open (command names +
    // /resume titles): the typeahead's accept submits the completed form
    // exactly once; the raw text-layer submit yields. Without this, the raw
    // listener (registered child-first, ahead of the typeahead's) submitted
    // the raw buffer too — one Enter, two executions, with the duplicate
    // queued behind the first. Directory menus stay raw-owned: their accept
    // deliberately lets the host submit the line as typed.
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
          // The range seam is supplied ONLY to the non-vim input; the vim
          // variant receives the ordinary props (no selection-range editing).
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

  // The standing amber line while on the failover lane — the lane,
  // the current model, the HOME family's stated reset time while its
  // window still stands, and the way home (contract data: `/model`).
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
        // The typed-through consent card is only HELD, never answered: the
        // cue names the pending ask, or the held tool call vanishes without
        // a trace until the suppression lapses.
        <Box marginTop={1} marginLeft={2}>
          <Text dimColor>Waiting for permission…</Text>
        </Box>
      ) : null}
      {frame}
      <MercurySupercodeKeywordHint value={input} />
      <PromptInputStashNotice hasStash={stash !== undefined} />
      {fullscreen ? (
        // Left-anchored with the composer stack it annotates: the cockpit's
        // whole footer column reads left, and a right-floating notice
        // painted as detached chrome at every width.
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
