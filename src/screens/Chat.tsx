
import type { UUID } from 'node:crypto';
import { query } from '../query.js';
import { takeResumeFoldNotice } from '../services/run/runCoordinator.js';
import { subscribeTranscriptLoadDegradation, transcriptLoadDegradation } from '../utils/sessionStorage/loading.js';
import { subscribeTranscriptStoreHealth, transcriptStoreHealth } from '../utils/sessionStorage/writer.js';
import { basename as nodePathBasename, join } from 'node:path';
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js';
import { commandOffInPlainWorld, commandSeat, getCommandName, isCommandEnabled, type Command, type ResumeEntrypoint } from '../commands.js';
import { ExitFlow } from '../components/ExitFlow.js';
import { FullscreenLayout } from '../components/FullscreenLayout.js';
import { TranscriptSwap } from '../components/CrewmateTranscript.js';
import { Messages } from '../components/Messages.js';
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js';
import PromptInput from '../components/PromptInput/PromptInput.js';
import { MessageActionsBar } from '../components/messageActions.js';
import { FocusedSessionStatusRow } from '../components/SwitchboardTagBar.js';
import { useLayoutChrome } from '../context/layoutChromeContext.js';
import { useCompactWorkControls } from '../components/tasks/CompactWorkSummary.js';
import {
  useKickOffCheckAndDisableSovereignIfNeeded,
} from '../utils/permissions/bypassPermissionsKillswitch.js';
import { useExtensions } from '../hooks/useExtensions.js';
import { useCostSummary } from '../costHook.js';
import { useFpsMetrics } from '../context/fpsMetrics.js';
import { startBackgroundHousekeeping } from '../utils/backgroundHousekeeping.js';
import { scheduleQuietUpdateNotice, UPDATE_NOTICE_KEY } from '../services/privateChannel/quietUpdateNotice.js';
import { isSettingsPopupOpen } from '../utils/cockpit/settingsPopup.js';
import { publishMcpConnections } from '../utils/cockpit/mcpGauge.js';
import { useSeatReceipts } from '../hooks/useSeatReceipts.js';
import { useAgentNeedsYou } from '../hooks/useAgentNeedsYou.js';
import { useMcpConnectivityStatus } from '../hooks/notifs/useMcpConnectivityStatus.js';
import { recordBootInteractive } from '../utils/observability/frictionStopwatch.js';
import { submitTrace } from '../utils/submitTrace.js';
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js';
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js';
import { LOCAL_COMMAND_STDOUT_TAG } from '../constants/xml.js';
import { CockpitBottomStatus } from '../context/cockpitActiveContext.js';
import { MercuryFrame } from '../components/MercuryFrame.js';
import { splitWayOut, useNotifications } from '../context/notifications.js';
import { performUiRouteAlias } from '../context/routeAliases.js';
import { currentSurfaceRoute, subscribeSurfaceRoute } from '../context/surfaceRoute.js';
import { useAgentsChange } from '../hooks/useAgentsChange.js';
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useMergedCommands } from '../hooks/useMergedCommands.js';
import { useMergedTools } from '../hooks/useMergedTools.js';
import { useTurnEndPing } from '../hooks/useTurnEndPing.js';
import { useFinishMarks } from '../hooks/useFinishMarks.js';
import { useSessionTitleMint } from '../hooks/useSessionTitleMint.js';
import { useSettingsChange } from '../hooks/useSettingsChange.js';
import { useSkillsChange } from '../hooks/useSkillsChange.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useDeprecationWarningNotification } from '../hooks/notifs/useDeprecationWarningNotification.js';
import { useLspInitializationNotification } from '../hooks/notifs/useLspInitializationNotification.js';
import { useRateLimitWarningNotification } from '../hooks/notifs/useRateLimitWarningNotification.js';
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js';
import { Box, Text, useTheme } from '../ink.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import { streamingRevealSuppressed } from '../ink/session/capabilities.js';
import * as pendingInput from '../input-core/pending-input.js';
import { HELD_FOR_COMPACTION_LINE } from '../components/messages/TranscriptNameplate.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';
import { hasSeatLive, IDLE_LIVE, type SessionLiveV1 } from '../services/engine-connector/seatLive.js';
import { interruptFocusedTurn } from '../hooks/useCancelRequest.js';
import { useFocusedTailAnchor, useFocusedTranscript } from '../hooks/useFocusedTranscript.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import type { AppState } from '../state/AppStateStore.js';
import {
  getFocusedSessionConnector,
  hasFocusedSession,
  landingInFlight,
  subscribeFocusedSessionConnector,
  subscribeThroughFocused,
  conversationIdHere,
} from '../services/engine-connector/focusedConnector.js';
import { flagEnv } from '../substrate/flagRegistry.js';
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js';
import type { Tool } from '../Tool.js';
import { ChatKeys } from './chat/ChatKeys.js';
import type { FocusedInputDialog } from './chat/focusedDialog.js';
import { RECEIPT_TIMEOUT_MS, SWITCH_STATUS_TIMEOUT_MS } from './chat/limits.js';
import type { Screen as ScreenName } from './chat/screen.js';
import type { PaintsRows, ResumableLog } from './chat/sessionShapes.js';
import { useChatAsks, useChatAsksCard } from './chat/useChatAsks.js';
import { loadContextWindowWarmup, loadDaemonHandshake, loadEnsureDaemon, loadHopIntoSession, loadProjectSnapshot, useChatCrashResume } from './chat/useChatBoot.js';
import { type ToolJSXState, useChatDialogPaints, useChatDialogs, useChatDialogsView } from './chat/useChatDialogs.js';
import { useChatDraft } from './chat/useChatDraft.js';
import { useChatScroll, useChatScrollFollow, useChatScrollPin } from './chat/useChatScroll.js';
import { TranscriptFooter, TranscriptSearchBar, useChatSearch } from './chat/useChatSearch.js';
import { useChatSelector, useChatSelectorView } from './chat/useChatSelector.js';
import { useChatConversation, useChatSession } from './chat/useChatSession.js';
import { useChatSeatClock, useChatStatusStrip, useChatTurnBoundary, useChatTurnEnd, useChatTurnSignals } from './chat/useChatStatus.js';
import { AnimatedTitle, useChatTitle } from './chat/useChatTitle.js';
import type { SessionListing } from '../types/logs.js';
import type { Message, UserMessage } from '../types/message.js';
import type { PromptInputMode } from '../types/textInputTypes.js';
import { createAbortController } from '../utils/abortController.js';
import type { PastedContent } from '../utils/config/schema.js';
import {
  crashReportDirDisplay,
  markCrashReportsNoticed,
  resolveCrashTranscript,
  setCrashConversationLocator,
  unnoticedCrashReports,
} from '../utils/crashReport.js';
import { clearedSessionAt } from '../utils/sessionStorage/clearedSessions.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { getCwd } from '../utils/cwd.js';
import { logForDebugging } from '../utils/debug.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../utils/fileStateCache.js';
import { isFullscreenEnvEnabled, isMouseTrackingEnabled, maybeGetTmuxMouseHint } from '../utils/fullscreen.js';
import type { PromptInputHelpers } from '../types/promptInputHelpers.js';
import { formatCommandLoadingMetadata, resolveUnknownSlashName, unavailableCommandLine, unknownCommandLine } from '../utils/processUserInput/processSlashCommand.js';
import { addToHistory, expandPastedTextRefs, resolvePastedContents } from '../history.js';
import { mercuryBootPreflightEnabled, runAndRecordPreflight } from '../utils/healthPreflight.js';
import { windowsShellRoadNotice } from '../utils/shell/windowsShellRoad.js';
import { createCommandInputMessage, createUserMessage, getUserMessageText } from '../utils/messages.js';
import { getCurrentWorktreeSession } from '../utils/worktree.js';
import type { StreamingToolUse } from '../utils/messages/streaming.js';

export type Screen = ScreenName;

export type Props = {
  commands: Command[];
  debug?: boolean;
  initialTools: Tool[];
  disabled?: boolean;
  disableSlashCommands?: boolean;
};

const WORKTREE_TIP_SECONDS = 15;
const BOOT_WARMUP_MS = 150;

const HELD_FOR_LANDING: ReadonlySet<string> = new Set(['swarm', 'swarmchat', 'general', 'team', 'whisper', 'rename', 'title', 'contract', 'crewmates']);
const EMPTY_CONFIRM_QUEUE: ToolUseConfirm[] = [];
const NO_STREAMING_TOOL_USES: StreamingToolUse[] = [];

const subscribeFocusedSeatLive = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.subscribeLive(listener) : () => {},
);
const getFocusedSeatLive = (): SessionLiveV1 => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? connector.live() : IDLE_LIVE;
};
setCrashConversationLocator(() => {
  const sessionId = conversationIdHere();
  if (!hasFocusedSession()) return { sessionId, transcriptPath: null };
  try {
    return { sessionId, transcriptPath: join(getProjectDir(getFocusedSessionConnector().workspace().projectRoot), `${sessionId}.jsonl`) };
  } catch {
    return { sessionId, transcriptPath: null };
  }
});
const subscribeFocusedModel = subscribeThroughFocused((connector, listener) => connector.subscribeModel(listener));
const getFocusedEffectiveModel = (): string => getFocusedSessionConnector().modelFacts().effective;
const subscribeFocusedTail = subscribeThroughFocused((connector, listener) =>
  hasSeatLive(connector) ? connector.tail().subscribe(listener) : () => {},
);
const getFocusedTailActive = (): boolean => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? connector.tail().getSnapshot() !== null : false;
};
const getFocusedStatusKey = (): string => {
  const connector = getFocusedSessionConnector();
  return hasSeatLive(connector) ? `${connector.status().interrupting ? 1 : 0}` : '0';
};

const NO_MCP_CLIENTS: never[] = [];

const INERT_PROMPT_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
};



function getFocusedInputDialog(args: {
  isExiting: boolean;
  showMessageSelector: boolean;
  isPromptInputActive: boolean;
  toolJSX: ToolJSXState;
  toolUseConfirmQueueLength: number;
  elicitationQueueLength: number;
  showCostThreshold: boolean;
  showCrashResume: boolean;
}): FocusedInputDialog | undefined {
  const { isExiting, showMessageSelector, isPromptInputActive, toolJSX, toolUseConfirmQueueLength, elicitationQueueLength, showCostThreshold, showCrashResume } = args;
  if (isExiting) return undefined;
  if (showMessageSelector) return 'message-selector';
  if (isPromptInputActive) return undefined;
  const blocked = toolJSX !== null && toolJSX.jsx !== null && toolJSX.shouldContinueAnimation !== true;
  if (blocked) return undefined;
  if (toolUseConfirmQueueLength > 0) return 'tool-permission';
  if (elicitationQueueLength > 0) return 'elicitation';
  if (showCostThreshold) return 'cost-threshold';
  if (showCrashResume) return 'crash-resume';
  return undefined;
}

function resolveSlashCommand(input: string, commands: Command[]): Command | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
  if (!name) return undefined;
  return commands.find(
    command =>
      isCommandEnabled(command) &&
      (command.name === name || command.aliases?.includes(name) === true || getCommandName(command) === name),
  );
}

function resolveGatedPlainWorldCommand(input: string, commands: Command[]): Command | undefined {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return undefined;
  const spaceIndex = trimmed.indexOf(' ');
  const name = (spaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIndex)).trim();
  if (!name) return undefined;
  const real = commands.find(
    command => command.name === name || command.aliases?.includes(name) === true || getCommandName(command) === name,
  );
  return real !== undefined && commandOffInPlainWorld(real) ? real : undefined;
}

export function Chat({
  commands: initialCommands,
  debug = false,
  initialTools,
  disabled = false,
  disableSlashCommands = false,
}: Props): React.ReactNode {
  fluxMark('render:chat-root');
  const rootWhyRef = useRef<Record<string, unknown> | null>(null);
  if (flagEnv('MERCURY_RENDER_FAULT') === 'chat') {
    throw new Error('deterministic Chat render fault (MERCURY_RENDER_FAULT=chat)');
  }

  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const { addNotification, removeNotification } = useNotifications();
  const { columns, rows } = useTerminalSize();
  const { isCompact } = useLayoutChrome();
  const { controls: compactWork, focus: compactFocus } = useCompactWorkControls();
  const tokens = useMercuryTokens();
  const [themeName] = useTheme();
  const engineModel = useEngineModel();

  const [fullscreen] = useState(() => isFullscreenEnvEnabled());
  const [virtualScrollEnabled] = useState(() => resolveTerminalExperience().virtualScroll.effective);
  const [terminalTitleEnabled] = useState(() => resolveTerminalExperience().terminalTitle.effective);

  const focusedConnector = useSyncExternalStore(subscribeFocusedSessionConnector, getFocusedSessionConnector, getFocusedSessionConnector);
  const seatLive = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedSeatLive, getFocusedSeatLive);
  const focusedEffectiveModel = useSyncExternalStore(subscribeFocusedModel, getFocusedEffectiveModel, getFocusedEffectiveModel);
  const textActive = useSyncExternalStore(subscribeFocusedTail, getFocusedTailActive, getFocusedTailActive);
  const interruptingKey = useSyncExternalStore(subscribeFocusedSeatLive, getFocusedStatusKey, getFocusedStatusKey);
  const isStopping = interruptingKey === '1';
  const focusedTail = hasSeatLive(focusedConnector) ? focusedConnector.tail() : null;
  const isLoading = seatLive.inFlight;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  const { pendingModelSwitch } = useChatTurnBoundary({ isLoading, setAppState, addNotification });

  const messages = useFocusedTranscript();
  const tailAnchor = useFocusedTailAnchor();
  const { conversationId, setConversationId } = useChatConversation(focusedConnector);
  const { toolJSX, setToolJSX, isExiting, showExitFlow, setShowExitFlow, exitCommandJsx, showCostThreshold, setShowCostThreshold, showBashesDialog, setShowBashesDialog, handleExit } = useChatDialogs({ store });
  const { showMessageSelector, setShowMessageSelector, openMessageSelector, messageSelectorPreselect, setMessageSelectorPreselect } = useChatSelector();
  const [submitCount, setSubmitCount] = useState(0);
  const { crashResumeStaged, setCrashResumeStaged, crashNoticeLatchedRef } = useChatCrashResume();

  const mcpState = useAppState(state => state.mcp);
  useEffect(() => {
    publishMcpConnections(mcpState.clients);
  }, [mcpState.clients]);
  useMcpConnectivityStatus({ mcpClients: mcpState.clients });
  const toolPermissionContext = useAppState(state => state.toolPermissionContext);
  const agentDefinitions = useAppState(state => state.agentDefinitions);
  const verbose = useAppState(state => state.verbose);
  const spinnerTip = useAppState(state => state.spinnerTip);
  const commands = useMergedCommands(initialCommands, mcpState.commands);
  const mergedTools = useMergedTools(initialTools, mcpState.tools, toolPermissionContext);
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const apiKeyVerification = useApiKeyVerification();

  const paintScreenRow = useCallback((row: Message, fallbackText: string): void => {
    const focused = getFocusedSessionConnector() as PaintsRows;
    if (typeof focused.addDisplayRow === 'function') {
      focused.addDisplayRow(row);
      return;
    }
    addNotification({ key: `screen-row-${Date.now()}`, text: fallbackText, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }, [addNotification]);

  const { scrollRef, scrollRestoreRef, modalScrollRef, lastUserScrollAtRef, repinToBottom, noteUserScroll } = useChatScrollPin();
  const { isPromptInputActive, setInputValue, setInputMode, setPastedContents, authWallHold, insertTextRef, vimMode, setVimMode, isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen } = useChatDraft({ messages, fullscreen, repinToBottom, lastUserScrollAtRef });

  const prefersReducedMotion = useAppState(state => state.settings.view?.reducedMotion === true);
  const reducedMotion = prefersReducedMotion || isEnvTruthy(flagEnv('MERCURY_REDUCED_MOTION'));
  const streamingSuppressed = streamingRevealSuppressed(reducedMotion, fullscreen);

  const { sessionAsks, toolUseConfirmQueue, resolvedConsentCount, resolveHeadPermission, setToolPermissionContext, elicitationQueue, respondToElicitation, dismissElicitationWaiting } = useChatAsks({ setAppState, addNotification });
  const chatSurfaceCovered = useSyncExternalStore(
    subscribeSurfaceRoute,
    () => currentSurfaceRoute().kind !== 'repl',
    () => currentSurfaceRoute().kind !== 'repl',
  );

  useSeatReceipts({
    setMessages: next => {
      const rows = typeof next === 'function' ? next([]) : next;
      for (const row of rows) paintScreenRow(row, '');
    },
  });
  useAgentNeedsYou(messages, isLoading);
  const focusedInputDialog = getFocusedInputDialog({
    isExiting: isExiting || showExitFlow,
    showMessageSelector,
    isPromptInputActive,
    toolJSX,
    toolUseConfirmQueueLength: toolUseConfirmQueue.length,
    elicitationQueueLength: elicitationQueue.length,
    showCostThreshold,
    showCrashResume: crashResumeStaged !== null,
  });
  const dialogsHiddenWhileTyping =
    isPromptInputActive && !isExiting && !showMessageSelector && (toolUseConfirmQueue.length > 0 || showCostThreshold);

  const { seatStartTimeRef, seatPausedMsRef, seatPauseStartRef } = useChatSeatClock({ seatLive, focusedInputDialog, isLoading });

  const { permissionOverlay } = useChatAsksCard({ focusedInputDialog, repinToBottom, toolUseConfirmQueue, resolvedConsentCount, resolveHeadPermission, chatSurfaceCovered, verbose });
  const readFileStateRef = useRef<FileStateCache | null>(null);
  const getReadFileState = useCallback((): FileStateCache => {
    if (readFileStateRef.current === null) {
      readFileStateRef.current = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE);
    }
    return readFileStateRef.current;
  }, []);

  const resumeRef = useRef<(sessionId: UUID, log: SessionListing, entrypoint: ResumeEntrypoint) => Promise<void>>(async () => {});
  const getToolUseContext = useCallback(
    (currentMessages: Message[], newMessages: Message[], controller: AbortController, model: string) => {
      const state = store.getState();
      const context = {
        options: {
          commands: commandsRef.current,
          debug,
          engineModel: model,
          tools: mergedTools,
          verbose: state.verbose,
          mcpClients: [],
          mcpResources: state.mcp.resources,
          isNonInteractiveSession: false,
          agentDefinitions: state.agentDefinitions,
          querySource: 'main_thread' as const,
          refreshTools: () => mergedTools,
          theme: themeName,
        },
        startTurn: query,
        abortController: controller,
        readFileState: getReadFileState(),
        discoveredSkillNames: new Set<string>(),
        loadedNestedMemoryPaths: new Set<string>(),
        getAppState: () => store.getState(),
        setAppState,
        setToolJSX,
        addNotification,
        appendSystemMessage: (msg: Message) => paintScreenRow(msg, getUserMessageText(msg as UserMessage) ?? ''),
        setInProgressToolUseIDs: () => {},
        setHasInterruptibleToolInProgress: () => {},
        setResponseLength: () => {},
        setStreamMode: () => {},
        openMessageSelector: () => setShowMessageSelector(true),
        updateFileHistoryState: (updater: (prev: AppState['fileHistory']) => AppState['fileHistory']) =>
          setAppState(prev => ({ ...prev, fileHistory: updater(prev.fileHistory) })),
        updateAttributionState: (updater: (prev: AppState['attribution']) => AppState['attribution']) =>
          setAppState(prev => ({ ...prev, attribution: updater(prev.attribution) })),
        setConversationId: (id: UUID) => setConversationId(id),
        messages: currentMessages.concat(newMessages),
        setMessages: (updater: (prev: Message[]) => Message[]) => {
          for (const row of updater([])) paintScreenRow(row, getUserMessageText(row as UserMessage) ?? '');
        },
        onChangeAPIKey: () => {
          void apiKeyVerification.reverify();
        },
        resume: (sessionId: UUID, log: SessionListing, entrypoint: ResumeEntrypoint) => resumeRef.current(sessionId, log, entrypoint),
      };
      return context;
    },
    [store, debug, mergedTools, themeName, getReadFileState, setAppState, setToolJSX, addNotification, paintScreenRow, apiKeyVerification],
  );

  const { lastCompletedAt } = useChatTurnEnd({ focusedConnector, isLoading, setAppState, themeName, getReadFileState, seatPausedMsRef, seatPauseStartRef });

  const resume = useCallback(async (sessionId: UUID, log: ResumableLog, entrypoint: ResumeEntrypoint): Promise<void> => {
    void entrypoint;
    const label = log.customTitle ?? log.agentName ?? String(sessionId).slice(0, 8);
    addNotification({
      key: 'session-switch',
      text: `opening ${label}…`,
      priority: 'medium',
      timeoutMs: SWITCH_STATUS_TIMEOUT_MS,
    });
    const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js');
    const outcome = await focusResumedSession(String(sessionId), (log as { fullPath?: string }).fullPath, {
      title: label,
      permissionMode: store.getState().toolPermissionContext.mode,
    });
    removeNotification('session-switch');
    if (!outcome.ok) {
      addNotification({
        key: 'resume-hop',
        text: `the session could not be opened — ${outcome.reason}`,
        priority: 'high',
        color: 'error',
        timeoutMs: RECEIPT_TIMEOUT_MS,
      });
      return;
    }
    setToolJSX(null);
  }, [addNotification, removeNotification, setToolJSX]);
  resumeRef.current = resume;

  useEffect(() => {
    const paintNoRunnerLine = (): void => {
      const focused = getFocusedSessionConnector() as {
        admissionRefusal?: () => string | null;
        record?: { title?: string };
        sessionId?: () => string;
      };
      const refusal = typeof focused.admissionRefusal === 'function' ? focused.admissionRefusal() : null;
      if (refusal === null || refusal === undefined) return;
      const title =
        focused.record?.title ??
        (typeof focused.sessionId === 'function' ? String(focused.sessionId()).slice(0, 8) : 'this session');
      void loadHopIntoSession().then(({ composeNoRunnerLine }) => {
        const segments = composeNoRunnerLine(title, refusal).split(' · ');
        addNotification({
          key: 'resume-hop',
          jsx: (
            <Box flexDirection="column">
              {segments.map(segment => (
                <Text key={segment} color="error" wrap="truncate-end">
                  {segment}
                </Text>
              ))}
            </Box>
          ),
          priority: 'high',
          timeoutMs: RECEIPT_TIMEOUT_MS * 2,
        });
      });
    };
    paintNoRunnerLine();
    return hasSeatLive(focusedConnector) ? focusedConnector.subscribeLive(paintNoRunnerLine) : undefined;
  }, [focusedConnector, addNotification]);

  const lostLinePaintedAtRef = useRef(0);
  useEffect(() => {
    if (!hasSeatLive(focusedConnector) || focusedConnector.lostLine === undefined) return undefined;
    const readLostLine = focusedConnector.lostLine.bind(focusedConnector);
    const paintLostLine = (): void => {
      const lost = readLostLine();
      if (lost === null || lost.atMs <= lostLinePaintedAtRef.current) return;
      lostLinePaintedAtRef.current = lost.atMs;
      addNotification({ key: 'lost-line', text: lost.text, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS * 2 });
    };
    paintLostLine();
    return focusedConnector.subscribeLive(paintLostLine);
  }, [focusedConnector, addNotification]);

  const paintScreenCommandReceipt = useCallback((commandName: string, args: string, text: string, timestamp = new Date().toISOString()): void => {
    const focused = getFocusedSessionConnector() as PaintsRows;
    if (typeof focused.addDisplayRow === 'function') {
      focused.addDisplayRow({ ...createUserMessage({ content: formatCommandLoadingMetadata(commandName, args) }), timestamp });
      focused.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${text}</${LOCAL_COMMAND_STDOUT_TAG}>`));
      return;
    }
    addNotification({ key: `command-${commandName}`, text, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }, [addNotification]);
  const dialogInFlightRef = useRef<{ name: string; mounted: boolean } | null>(null);
  const armedHandedBackRef = useRef<{ text: string; pastedContents: Record<number, PastedContent> } | null>(null);
  const queuedDialogCommandsRef = useRef<Array<{ input: string; name: string; submittedAt: string; pastedContents: Record<number, PastedContent> }>>([]);
  const { dialogSlotRef, dialogPaints, localJsx, compactDetailUp, dialogOwnsKeys } = useChatDialogPaints({ toolJSX, compactFocus, compactWork, fullscreen, chatSurfaceCovered, focusedInputDialog });
  const drainQueuedDialogCommand = useCallback((): void => {
    const next = queuedDialogCommandsRef.current.shift();
    if (next === undefined) return;
    void onSubmitRef.current(next.input, INERT_PROMPT_HELPERS, undefined, { rearmed: true, submittedAt: next.submittedAt, pastedContents: next.pastedContents });
  }, []);
  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, _speculationAccept?: unknown, options?: { fromKeybinding?: boolean; rearmed?: boolean; submittedAt?: string; pastedContents?: Record<number, PastedContent>; armedMode?: PromptInputMode }): Promise<void> => {
    const submittedAt = options?.submittedAt ?? new Date().toISOString();
    const text = input.trim();
    if (text === '') return;
    submitTrace('repl-onSubmit', input, { fromKeybinding: options?.fromKeybinding === true, speculation: false, guardActive: isLoadingRef.current });
    const focusedNow = getFocusedSessionConnector();
    const seatMode = options?.armedMode ?? pendingInput.mode();
    const seatPastes = options?.pastedContents ?? pendingInput.pastedContents();
    const seatCommand = text.startsWith('/') && seatMode !== 'bash' ? resolveSlashCommand(text, commandsRef.current) : undefined;
    const seat = seatCommand === undefined ? 'session' : commandSeat(seatCommand);
    const takeComposer = (): void => {
      if (options?.armedMode !== undefined) return;
      const composerLine = pendingInput.text().replace(/\s+$/, '');
      if (composerLine === input) pendingInput.clearForSubmit(input);
      if (composerLine === '' || composerLine === input) {
        setInputValue('');
        setPastedContents({});
        helpers.clearBuffer();
        helpers.setCursorOffset(0);
        helpers.resetHistory();
        setInputMode('prompt');
      }
      if (!options?.fromKeybinding && !options?.rearmed) addToHistory({ display: seatMode === 'bash' ? `!${input}` : input, pastedContents: seatPastes });
    };
    const armForLanding = (): void => {
      takeComposer();
      const line = { message: createUserMessage({ content: text }), ...(seatMode === 'bash' ? { bashMode: true } : {}), pastedContents: seatPastes };
      setAppState(prev => ({
        ...prev,
        initialMessage: prev.initialMessage === null ? { ...line, armedAtLanding: true } : { ...prev.initialMessage, armedBehind: [...(prev.initialMessage.armedBehind ?? []), line] },
      }));
    };
    const words = expandPastedTextRefs(text, seatPastes).trim();
    if (seatCommand === undefined && words.startsWith('/') && seatMode !== 'bash') {
      const gated = resolveGatedPlainWorldCommand(words, commandsRef.current);
      if (gated !== undefined) {
        takeComposer();
        paintScreenCommandReceipt(getCommandName(gated), '', unavailableCommandLine(gated));
        return;
      }
      const unknownName = resolveUnknownSlashName(words, commandsRef.current);
      if (unknownName !== undefined) {
        takeComposer();
        paintScreenCommandReceipt(unknownName, '', unknownCommandLine(unknownName, commandsRef.current));
        return;
      }
    }
    if (seat === 'session') {
      if (landingInFlight() && !hasFocusedSession()) {
        armForLanding();
        addNotification({ key: 'landing-hold', text: 'the session is landing — your line sends when it lands', priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
        return;
      }
      takeComposer();
      repinToBottom();
      setSubmitCount(count => count + 1);
      if (seatCommand !== undefined && isLoadingRef.current) {
        addNotification({
          key: 'session-command-queued',
          text: `/${getCommandName(seatCommand)} queued — runs when the current turn ends (esc interrupts the turn)`,
          priority: 'immediate',
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
      }
      if (getFocusedSeatLive().phase === 'compacting') {
        addNotification({
          key: 'held-for-compaction',
          text: HELD_FOR_COMPACTION_LINE,
          priority: 'immediate',
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
      }
      const sent = focusedNow
        .sendWords(text, {
          mode: seatMode,
          pastedContents: seatPastes,
          ...(options?.fromKeybinding ? { fromKeybinding: true } : {}),
        })
        .then(receipt => {
          if (receipt.state !== 'refused') return;
          const handedBack = armedHandedBackRef.current;
          if (pendingInput.text() === '') {
            if (pendingInput.restoreStaged(input) === null) setInputValue(input);
            setPastedContents(seatPastes);
            if (handedBack !== null) {
              setInputMode('prompt');
              armedHandedBackRef.current = { text: pendingInput.text(), pastedContents: seatPastes };
            }
          } else if (handedBack !== null && handedBack.text !== '' && pendingInput.text() === handedBack.text) {
            const pastedContents = { ...handedBack.pastedContents, ...seatPastes };
            setInputValue(`${handedBack.text}\n${input}`);
            setPastedContents(pastedContents);
            armedHandedBackRef.current = { text: pendingInput.text(), pastedContents };
          }
          addNotification({
            key: 'focused-session-send',
            text: receipt.detail,
            priority: 'high',
            color: 'error' as const,
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
        });
      if (options?.armedMode !== undefined) await sent;
      return;
    }
    const spaceAt = text.indexOf(' ');
    const args = spaceAt === -1 ? '' : text.slice(spaceAt + 1).trim();
    const argsWithPastes = async (): Promise<string> => expandPastedTextRefs(args, (await resolvePastedContents(args, seatPastes)).pastedContents).trim();
    if (seatCommand !== undefined && (seatCommand.type === 'local-jsx' && seatCommand.name === 'mission' ? args !== '' : HELD_FOR_LANDING.has(seatCommand.name)) && landingInFlight() && !hasFocusedSession()) {
      armForLanding();
      addNotification({ key: 'landing-hold', text: `the session is landing — /${getCommandName(seatCommand)} sends when it lands`, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
      return;
    }
    if (seatCommand !== undefined && seatCommand.type === 'local' && seatCommand.uiRouteAlias === undefined) {
      takeComposer();
      const ran = (async () => {
        try {
          if (seatCommand.interruptFirst === true && focusedNow.turnActive()) {
            focusedNow.interrupt();
          }
          const context = getToolUseContext([...focusedNow.records()], [], createAbortController(), focusedNow.modelFacts().effective);
          const module = await seatCommand.load();
          const result = await module.call(await argsWithPastes(), context);
          if (result.type === 'text' && result.value.trim() !== '') paintScreenCommandReceipt(getCommandName(seatCommand), args, result.value, submittedAt);
        } catch (error) {
          logForDebugging(`screen command /${seatCommand.name} failed: ${String(error)}`);
          addNotification({ key: `command-${seatCommand.name}`, text: `/${getCommandName(seatCommand)} failed — ${error instanceof Error ? error.message : String(error)}`, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS });
        }
      })();
      if (options?.armedMode !== undefined) await ran;
      return;
    }
    const routeAlias = (seatCommand as { uiRouteAlias?: 'concourse' } | undefined)?.uiRouteAlias;
    if (seatCommand !== undefined && routeAlias) {
      if (pendingInput.text().replace(/\s+$/, '') === input) setInputValue('');
      const outcome = performUiRouteAlias(routeAlias);
      if (outcome.note) {
        addNotification({ key: 'route-alias', text: outcome.note, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
      }
      return;
    }
    if (seatCommand !== undefined && seatCommand.type === 'local-jsx') {
      const dialogName = getCommandName(seatCommand);
      const inFlight = dialogInFlightRef.current;
      if (inFlight !== null) {
        takeComposer();
        queuedDialogCommandsRef.current.push({ input, name: dialogName, submittedAt, pastedContents: seatPastes });
        submitTrace('repl-dialog-queued', input, { name: dialogName, behind: inFlight.name });
        addNotification({
          key: 'dialog-command-queued',
          text: `/${dialogName} queued — runs when /${inFlight.name} settles`,
          priority: 'immediate',
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
        return;
      }
      const slot = { name: dialogName, mounted: false };
      dialogInFlightRef.current = slot;
      submitTrace('repl-dialog-dispatch', input, { name: dialogName, rearmed: options?.rearmed === true });
      const releaseDialogSlot = (): void => {
        if (dialogInFlightRef.current !== slot) return;
        dialogInFlightRef.current = null;
        if (!slot.mounted) drainQueuedDialogCommand();
      };
      if (pendingInput.text().replace(/\s+$/, '') === input) {
        pendingInput.clearForSubmit(input);
        setInputValue('');
      }
      const context = getToolUseContext([...focusedNow.records()], [], createAbortController(), focusedNow.modelFacts().effective);
      let completed = false;
      const onDone = (
        result?: string,
        doneOptions?: { display?: 'skip' | 'system' | 'user'; nextInput?: string; submitNextInput?: boolean; shouldQuery?: boolean; metaMessages?: string[] },
      ): void => {
        completed = true;
        submitTrace('repl-dialog-done', input, { name: dialogName, result: (result ?? '').slice(0, 80), display: doneOptions?.display ?? 'user', shouldQuery: doneOptions?.shouldQuery === true });
        releaseDialogSlot();
        setToolJSX(null);
        if (result && doneOptions?.display !== 'skip') {
          const resultLines = result.split(/\r?\n/).filter(line => line.trim() !== '').length;
          if (resultLines > 1) paintScreenCommandReceipt(dialogName, args, result, submittedAt);
          else addNotification({ key: `command-${seatCommand.name}`, text: result, priority: 'immediate' });
        }
        if (doneOptions?.shouldQuery === true) {
          const metaRows = (doneOptions.metaMessages ?? []).filter(words => words.trim() !== '');
          submitTrace('repl-dialog-query', input, { name: dialogName, metaRows: metaRows.length });
          void (async () => {
            for (const words of metaRows) {
              const receipt = await focusedNow.sendWords(words, { metaFrom: { command: seatCommand.name } });
              if (receipt.state === 'refused') {
                addNotification({ key: `command-${seatCommand.name}-query`, text: `/${dialogName} could not start the turn — ${receipt.detail}`, priority: 'high', color: 'error' as const, timeoutMs: RECEIPT_TIMEOUT_MS });
                return;
              }
            }
          })();
        }
        if (doneOptions?.nextInput) {
          if (doneOptions.submitNextInput) void onSubmitRef.current(doneOptions.nextInput, INERT_PROMPT_HELPERS);
          else setInputValue(doneOptions.nextInput);
        }
        pendingInput.popStash();
        if (seatCommand.name === 'logins' || seatCommand.name === 'model') {
          authWallHold.afterDoor(seatCommand.name, hold => {
            void onSubmitRef.current(hold.text, INERT_PROMPT_HELPERS, undefined, { rearmed: true });
          });
        }
      };
      try {
        const module = await seatCommand.load();
        const element = await module.call(onDone, context, await argsWithPastes(), text.slice(1, spaceAt === -1 ? undefined : spaceAt));
        if (element && !completed) {
          slot.mounted = true;
          setToolJSX({ jsx: element, shouldHidePromptInput: false, isLocalJSXCommand: true, isImmediate: true });
        } else if (!element && !completed && !isSettingsPopupOpen()) {
          addNotification({
            key: `command-${seatCommand.name}`,
            text: `/${getCommandName(seatCommand)} had nothing to show`,
            priority: 'immediate',
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
          releaseDialogSlot();
        }
      } catch (error) {
        logForDebugging(`dialog command /${seatCommand.name} failed: ${String(error)}`);
        addNotification({
          key: `command-${seatCommand.name}`,
          text: `/${getCommandName(seatCommand)} failed — ${error instanceof Error ? error.message : String(error)}`,
          priority: 'high',
          color: 'error' as const,
          timeoutMs: RECEIPT_TIMEOUT_MS,
        });
        releaseDialogSlot();
      }
    }
  }, [addNotification, authWallHold, drainQueuedDialogCommand, getToolUseContext, lastCompletedAt, paintScreenCommandReceipt, repinToBottom, setInputMode, setInputValue, setPastedContents, setToolJSX]);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  useEffect(() => {
    if (toolJSX !== null) return;
    const slot = dialogInFlightRef.current;
    if (slot !== null && slot.mounted) dialogInFlightRef.current = null;
    if (dialogInFlightRef.current === null) drainQueuedDialogCommand();
  }, [toolJSX, drainQueuedDialogCommand]);

  const onCancel = useCallback(() => {
    interruptFocusedTurn();
  }, []);

  const landing = useSyncExternalStore(subscribeFocusedSessionConnector, landingInFlight, landingInFlight);
  const armedMessage = useAppState(state => state.initialMessage);
  useEffect(() => {
    if (armedMessage === null) return;
    if (landing) return;
    setAppState(prev => (prev.initialMessage === null ? prev : { ...prev, initialMessage: null }));
    void (async () => {
      armedHandedBackRef.current = { text: '', pastedContents: {} };
      for (const line of [armedMessage, ...(armedMessage.armedBehind ?? [])]) {
        const text = (getUserMessageText(line.message) ?? '').trim();
        if (text === '') continue;
        const armed = line !== armedMessage || armedMessage.armedAtLanding === true;
        try {
          await onSubmitRef.current(text, INERT_PROMPT_HELPERS, undefined, armed ? { rearmed: true, pastedContents: line.pastedContents ?? {}, armedMode: line.bashMode ? 'bash' : 'prompt' } : undefined);
        } catch (error) {
          logForDebugging(`a line armed for the landing was not submitted: ${String(error)}`);
        }
      }
      armedHandedBackRef.current = null;
    })();
  }, [armedMessage, landing, setAppState]);

  useFinishMarks();
  useSessionTitleMint();
  useSettingsChange(() => {});
  useAgentsChange(getCwd());
  useSkillsChange(getCwd(), () => {});
  useKickOffCheckAndDisableSovereignIfNeeded();
  useExtensions({ enabled: true });
  useCostSummary(useFpsMetrics());

  useEffect(() => {
    recordBootInteractive();
    setTimeout(() => {
      void loadEnsureDaemon()
        .then(async m => {
          if (await m.ensureOwnedDaemon()) await m.warmSessionRunner(getCwd());
        })
        .catch(() => {});
    }, 0);
    setTimeout(() => {
      void loadContextWindowWarmup()
        .then(m => m.warmContextWindowSources())
        .catch(() => {});
    }, 0);
  }, []);

  useEffect(() => {
    const disarm = scheduleQuietUpdateNotice(text =>
      addNotification({ key: UPDATE_NOTICE_KEY, text, priority: 'high', color: 'warning', timeoutMs: Infinity }),
    );
    return disarm;
  }, []);

  useEffect(() => {
    const key = 'daemon-version';
    let alive = true;
    let unsubscribe = (): void => {};
    void loadDaemonHandshake()
      .then(hs => {
        if (!alive) return;
        const paint = (): void => {
          const line = hs.lastDaemonHandshake()?.line ?? null;
          if (line !== null) addNotification({ key, ...splitWayOut(line), priority: 'high', color: 'warning', timeoutMs: 60_000 });
          else removeNotification(key);
        };
        paint();
        unsubscribe = hs.subscribeDaemonHandshake(paint);
      })
      .catch(() => {});
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (submitCount !== 1) return;
    try {
      startBackgroundHousekeeping();
    } catch (error) {
      logForDebugging(`background housekeeping failed to start: ${String(error)}`);
    }
  }, [submitCount]);

  useChatTurnSignals({ isLoading, textActive, toolUseConfirmQueue, messages });

  useEffect(() => {
    const hosted = hasSeatLive(focusedConnector) && focusedConnector.transcriptStoreFailing !== undefined ? focusedConnector : null;
    const paint = (): void => {
      const health = transcriptStoreHealth();
      const sentence = health.failing ? health.sentence : (hosted?.transcriptStoreFailing?.() ?? undefined);
      if (sentence !== undefined) {
        addNotification({
          key: 'transcript-store',
          text: sentence || 'the session transcript store is failing to write',
          priority: 'high',
          timeoutMs: 3_600_000,
        });
      } else {
        removeNotification('transcript-store');
      }
    };
    paint();
    const offStore = subscribeTranscriptStoreHealth(paint);
    const offFacts = hosted?.subscribeModel(paint);
    return () => {
      offStore();
      offFacts?.();
    };
  }, [focusedConnector]);

  useEffect(() => {
    const paintDegradation = (): void => {
      try {
        const focused = getFocusedSessionConnector() as PaintsRows;
        const fact = transcriptLoadDegradation(typeof focused.transcriptFile === 'function' ? focused.transcriptFile() : undefined);
        if (!fact) {
          removeNotification('transcript-degraded');
          return;
        }
        const where = fact.path;
        addNotification({
          key: 'transcript-degraded',
          text:
            fact.refusal !== null
              ? `transcript refused on load: ${fact.refusal} — ${where} · this session resumed WITHOUT its prior records (nothing was repaired)`
              : `transcript degraded on load: ${fact.malformed} malformed, ${fact.invalid} invalid of ${fact.totalLines} line(s) — ${where} · the valid records loaded; nothing was repaired`,
          priority: 'high',
          timeoutMs: 3_600_000,
        });
      } catch {
      }
    };
    paintDegradation();
    return subscribeTranscriptLoadDegradation(paintDegradation);
  }, [focusedConnector]);

  useEffect(() => {
    if (!mercuryBootPreflightEnabled()) return;
    void runAndRecordPreflight()
      .then(summary => {
        const failing = summary.failing[0];
        if (!failing) return;
        addNotification({
          key: 'boot-preflight',
          text: `boot preflight: ${failing.id} failed${failing.evidence ? ` — ${failing.evidence}` : ''} · /health for details`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const notice = windowsShellRoadNotice();
    if (notice === null) return;
    addNotification({
      key: 'shell-road',
      text: `${notice} · /health`,
      priority: 'high',
      timeoutMs: 60_000,
    });
  }, []);

  useEffect(() => {
    try {
      const unnoticed = unnoticedCrashReports();
      const newest = unnoticed[0];
      if (!newest) return;
      const more = unnoticed.length - 1;
      const identityBits = [
        newest.sessionId !== null ? `session ${newest.sessionId.slice(0, 8)}` : null,
        newest.cwd !== null ? `in ${nodePathBasename(newest.cwd) || newest.cwd}` : null,
      ].filter((bit): bit is string => bit !== null);
      let resolved: ReturnType<typeof resolveCrashTranscript> = null;
      try {
        resolved = resolveCrashTranscript(newest, {
          projectDirOf: getProjectDir,
          currentCwd: getCwd(),
          excludeSessionIds: [String(getSessionId())],
          clearedAt: clearedSessionAt,
          notAfterMs: Date.now() - process.uptime() * 1000,
        });
      } catch {
      }
      const backInside = resolved !== null && resolved.sessionId === conversationIdHere();
      if (resolved !== null && !backInside) {
        setCrashResumeStaged({
          origin: newest.origin,
          component: newest.component,
          message: newest.message,
          sessionId: resolved.sessionId,
          cwd: newest.cwd,
          transcriptPath: resolved.transcriptPath,
          moreCount: more,
        });
        return;
      }
      const wayBack = backInside ? ' — this is that session, back in' : ' — its transcript is gone, so no re-entry is offered';
      addNotification({
        key: 'crash-reports',
        text: `a previous session crashed (${newest.origin}${newest.component ? ` in ${newest.component}` : ''} — ${newest.message.slice(0, 80)})${identityBits.length > 0 ? ` · ${identityBits.join(' ')}` : ''}${wayBack}${more > 0 ? ` +${more} more` : ''} · reports in ${crashReportDirDisplay()}`,
        priority: 'high',
        timeoutMs: 60_000,
      });
      if (!crashNoticeLatchedRef.current) {
        crashNoticeLatchedRef.current = true;
        markCrashReportsNoticed();
      }
    } catch {
    }
  }, []);

  useEffect(() => {
    if (focusedInputDialog === 'crash-resume' && !crashNoticeLatchedRef.current) {
      crashNoticeLatchedRef.current = true;
      try {
        markCrashReportsNoticed();
      } catch {
      }
    }
  }, [focusedInputDialog]);

  useEffect(() => {
    try {
      const notice = takeResumeFoldNotice();
      if (!notice) return;
      if (notice.interruptedTools > 0) {
        addNotification({
          key: 'resume-run-fold',
          text: `${notice.interruptedTools} tool call(s) interrupted — /run for details`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      }
      if (notice.blocker) {
        addNotification({
          key: 'resume-run-blocker',
          text: `${notice.blocker.description} — ${notice.blocker.resumeCondition}`,
          priority: 'high',
          timeoutMs: 60_000,
        });
      }
    } catch {
    }
  }, []);

  useEffect(() => {
    void apiKeyVerification.reverify({ probe: false }).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadProjectSnapshot()
        .then(m => m.getProjectSnapshotAsync(getOriginalCwd(), { maxStaleMs: 120_000 }))
        .catch(() => {});
    }, BOOT_WARMUP_MS);
    return () => clearTimeout(timer);
  }, []);

  useSettingsErrors();
  useRateLimitWarningNotification(engineModel);
  useDeprecationWarningNotification(engineModel);
  useLspInitializationNotification();

  const { title, titleAnimating, sessionTitleSetting } = useChatTitle({ focusedInputDialog, focusedConnector, isLoading, store });

  useTurnEndPing({ lastCompletedAt, busy: isLoading });

  const { centredModalUp, toolJSXRef, centredModal, bottomImmediateJsx, inlineToolJsx, focusedBottomDialog } = useChatDialogsView({ toolJSX, dialogSlotRef, localJsx, compactDetailUp, setShowCostThreshold, messages, fullscreen, compactWork, getToolUseContext, focusedEffectiveModel, chatSurfaceCovered, focusedInputDialog, elicitationQueue, respondToElicitation, dismissElicitationWaiting, crashResumeStaged, setCrashResumeStaged, addNotification, removeNotification, store });

  const worktreeTipShownRef = useRef(false);
  useEffect(() => {
    if (worktreeTipShownRef.current) return;
    const worktree = getCurrentWorktreeSession();
    if (!worktree || typeof worktree.creationDurationMs !== 'number') return;
    if (worktree.usedSparsePaths === true) return;
    const seconds = Math.round(worktree.creationDurationMs / 1000);
    if (seconds < WORKTREE_TIP_SECONDS) return;
    worktreeTipShownRef.current = true;
    addNotification({
      key: 'worktree-tip',
      text: `worktree creation took ${seconds}s — large repositories benefit from the sparse-paths setting, e.g. { "worktree": { "sparsePaths": ["src/"] } }`,
      priority: 'low',
      timeoutMs: 20_000,
    });
  }, []);

  useEffect(() => {
    if (!fullscreen) return;
    void maybeGetTmuxMouseHint().then(hint => {
      if (hint) addNotification({ key: 'tmux-mouse-hint', text: hint, priority: 'low', timeoutMs: RECEIPT_TIMEOUT_MS });
    }).catch(() => {});
  }, []);

  const { unseen, captureScrollForFlip, setFlipGeneration, unseenDivider, newMessageCount, onScroll, onPillClick } = useChatScroll({ messages, fullscreen, scrollRef, scrollRestoreRef, noteUserScroll });
  const {
    dumpMode,
    inVirtualTranscriptMode,
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    searchBarOpen,
    committedSearchQuery,
    searchMatchCount,
    searchMatchCurrent,
    editorStatus,
    jumpRef,
    handleEnterTranscript,
    handleExitTranscript,
    inTranscript,
    inVirtualTranscript,
    legacyTranscript,
    scanElement,
    setPositions,
    commitSearch,
    cancelSearch,
    previewSearch,
    warmSearchIndex,
    onSearchMatchesChange,
    transcriptMessages,
    onTranscriptScroll,
    onTranscriptPillClick,
  } = useChatSearch({ fullscreen, virtualScrollEnabled, columns, mergedTools, messages, focusedInputDialog, captureScrollForFlip, setFlipGeneration, scrollRef, scrollRestoreRef, onScroll });

  const { messageActionsDisabled, messageCursorActive, messageNavRef, messageActions, messageSelector } = useChatSelectorView({ addNotification, setInputValue, setInputMode, setShowMessageSelector, messageSelectorPreselect, setMessageSelectorPreselect, focusedInputDialog, chatSurfaceCovered, messages, onCancel, focusedEffectiveModel, handleEnterTranscript, setScreen, setShowAllInTranscript, isLoadingRef, resume });

  const { warmthVersion, paintedMessages, entryLoadingLine, displayedMessages, slotHasSession } = useChatSession({ focusedConnector, messages, compactWork, unseen, repinToBottom, setConversationId, setToolJSX, toolJSXRef, localJsx, landing, armedMessage, chatSurfaceCovered, inVirtualTranscript, transcriptMessages });

  useChatScrollFollow({ messages, repinToBottom });
  const { viewInProgressToolUseIDs, viewStreamMode, spinnerSlotReserved, workingStatusStrip } = useChatStatusStrip({ seatLive, messages, toolJSX, toolUseConfirmQueue, isLoading, isStopping, textActive, streamingSuppressed, isCompact, focusedConnector, spinnerTip, verbose, seatStartTimeRef, seatPausedMsRef, seatPauseStartRef });

  const promptInput = !disabled && !isExiting && !showExitFlow && !toolJSX?.shouldHidePromptInput && (focusedInputDialog === undefined || compactFocus === 'detail') ? (
    <PromptInput
      compactWork={compactWork}
      compactFocus={compactFocus}
      debug={debug}
      toolPermissionContext={toolPermissionContext}
      setToolPermissionContext={setToolPermissionContext}
      apiKeyStatus={apiKeyVerification.status}
      commands={disableSlashCommands ? [] : commands}
      agents={agentDefinitions.activeAgents}
      isLoading={isLoading}
      verbose={verbose}
      submitCount={submitCount}
      onShowMessageSelector={openMessageSelector}
      onMessageActionsEnter={messageActionsDisabled ? undefined : messageActions.enter}
      mcpClients={NO_MCP_CLIENTS}
      vimMode={vimMode}
      setVimMode={setVimMode}
      showBashesDialog={showBashesDialog}
      setShowBashesDialog={setShowBashesDialog}
      onExit={handleExit}
      getToolUseContext={getToolUseContext}
      onSubmit={onSubmit}
      isSearchingHistory={isSearchingHistory}
      setIsSearchingHistory={setIsSearchingHistory}
      helpOpen={helpOpen}
      setHelpOpen={setHelpOpen}
      hasSuppressedDialogs={dialogsHiddenWhileTyping}
      isLocalJSXCommandActive={(toolJSX?.isLocalJSXCommand === true && dialogPaints) || focusedInputDialog !== undefined}
      insertTextRef={insertTextRef}
    />
  ) : null;

  const composerGroup = promptInput ? <Box flexDirection="column" display={focusedInputDialog === undefined ? "flex" : "none"}>{promptInput}</Box> : null;
  const composerSlot =
    messageCursorActive && !messageActionsDisabled ? <MessageActionsBar /> : composerGroup;

  const bottomSlot = (
    <Box flexDirection="column">
      {inTranscript ? (
        searchBarOpen ? (
          <TranscriptSearchBar
            columns={columns}
            onQueryChange={previewSearch}
            onCommit={commitSearch}
            onCancel={cancelSearch}
            warmSearchIndex={warmSearchIndex}
            matchCount={searchMatchCount}
            matchCurrent={searchMatchCurrent}
          />
        ) : (
          <TranscriptFooter
            toggleChord={getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')}
            expandChord={getShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')}
            hasSearchBadge={committedSearchQuery !== '' && searchMatchCount !== null && searchMatchCount > 0}
            virtualScroll={inVirtualTranscript}
            showAllSuppressed={dumpMode}
            showAll={showAllInTranscript}
            status={editorStatus}
            badge={committedSearchQuery !== '' && searchMatchCount !== null && searchMatchCount > 0 ? `${searchMatchCurrent}/${searchMatchCount}` : null}
          />
        )
      ) : (
        composerSlot
      )}
    </Box>
  );

  const messagesList = inVirtualTranscript ? (
    <Messages
      messages={displayedMessages}
      tools={mergedTools}
      commands={commands}
      verbose
      toolJSX={null}
      toolUseConfirmQueue={EMPTY_CONFIRM_QUEUE}
      inProgressToolUseIDs={viewInProgressToolUseIDs}
      isMessageSelectorVisible={false}
      conversationId={conversationId}
      screen={screen}
      streamingToolUses={NO_STREAMING_TOOL_USES}
      showAllInTranscript={showAllInTranscript}
      agentDefinitions={agentDefinitions}
      isLoading={isLoading}
      streamingThinking={null}
      hidePastReasoning
      streamingTail={focusedTail}
      streamingTextSuppressed={streamingSuppressed}
      scrollRef={scrollRef}
      jumpRef={jumpRef}
      onSearchMatchesChange={onSearchMatchesChange}
      scanElement={scanElement}
      setPositions={setPositions}
      disableRenderCap={dumpMode}
    />
  ) : inTranscript ? (
    <Messages
      messages={displayedMessages}
      tools={mergedTools}
      commands={commands}
      verbose
      toolJSX={null}
      toolUseConfirmQueue={EMPTY_CONFIRM_QUEUE}
      inProgressToolUseIDs={viewInProgressToolUseIDs}
      isMessageSelectorVisible={showMessageSelector}
      conversationId={conversationId}
      screen={screen}
      streamingToolUses={NO_STREAMING_TOOL_USES}
      showAllInTranscript={showAllInTranscript}
      agentDefinitions={agentDefinitions}
      isLoading={isLoading}
      hidePastReasoning
      streamingTail={focusedTail}
      streamingTextSuppressed={streamingSuppressed}
      disableRenderCap={dumpMode}
    />
  ) : (
    <Messages
      messages={displayedMessages}
      tools={mergedTools}
      commands={commands}
      verbose={verbose}
      toolJSX={toolJSX}
      toolUseConfirmQueue={toolUseConfirmQueue}
      inProgressToolUseIDs={viewInProgressToolUseIDs}
      isMessageSelectorVisible={showMessageSelector}
      conversationId={conversationId}
      screen={screen}
      streamingToolUses={NO_STREAMING_TOOL_USES}
      showAllInTranscript={showAllInTranscript}
      agentDefinitions={agentDefinitions}
      isLoading={isLoading}
      streamingTail={focusedTail}
      streamingTextSuppressed={streamingSuppressed}
      tailAnchor={inVirtualTranscript || paintedMessages !== messages ? undefined : tailAnchor}
      unseenDivider={unseenDivider}
      scrollRef={scrollRef}
      jumpRef={jumpRef}
      onSearchMatchesChange={onSearchMatchesChange}
      scanElement={scanElement}
      setPositions={setPositions}
      disableRenderCap={dumpMode}
      ownsCursor
      cursorNavRef={messageNavRef}
    />
  );

  const transcriptBody = inVirtualTranscript ? (
    <Box flexDirection="column">
      {messagesList}
      {inlineToolJsx}
    </Box>
  ) : (
    <Box flexDirection="column">
      {entryLoadingLine !== null ? (
        <Box paddingLeft={1} marginTop={1}>
          <Text dimColor>{entryLoadingLine}</Text>
        </Box>
      ) : null}
      {messagesList}
      {inlineToolJsx}
      <Box flexGrow={1} />
    </Box>
  );

  const keys = {
    legacyTranscript,
    fullscreen,
    compactWork,
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messages,
    handleEnterTranscript,
    handleExitTranscript,
    inVirtualTranscriptMode,
    inVirtualTranscript,
    searchBarOpen,
    helpOpen,
    isSearchingHistory,
    messageCursorActive,
    messageActions,
    messageActionsDisabled,
    focusedInputDialog,
    toolUseConfirmQueue,
    showMessageSelector,
    showBashesDialog,
    vimMode,
    dialogOwnsKeys,
    centredModalUp,
    permissionOverlay,
    viewStreamMode,
    seatLive,
    onSubmit,
    commands,
    scrollRef,
    modalScrollRef,
    onScroll,
    onTranscriptScroll,
  };

  if (legacyTranscript) {
    return (
      <KeybindingSetup>
        <AnimatedTitle enabled={terminalTitleEnabled} title={title} wantsPrefix animating={titleAnimating} />
        <ChatKeys {...keys}>
          <Box flexDirection="column">
            {messagesList}
            {toolJSX?.jsx ?? null}
            <TranscriptFooter
              toggleChord={getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')}
              expandChord={getShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')}
              hasSearchBadge={false}
              virtualScroll={false}
              showAllSuppressed={dumpMode}
              showAll={showAllInTranscript}
              status={editorStatus}
              badge={null}
            />
          </Box>
        </ChatKeys>
      </KeybindingSetup>
    );
  }

  const tree = (
    <KeybindingSetup>
      <AnimatedTitle enabled={terminalTitleEnabled} title={title} wantsPrefix animating={titleAnimating} />
      <ChatKeys {...keys}>
        <FullscreenLayout
          scrollRef={scrollRef}
          statusBand={inVirtualTranscript ? undefined : workingStatusStrip}
          statusBandActive={inVirtualTranscript ? undefined : spinnerSlotReserved}
          overlay={inVirtualTranscript ? undefined : permissionOverlay}
          modal={inVirtualTranscript ? undefined : centredModalUp ? centredModal : undefined}
          modalActive={dialogOwnsKeys}
          modalScrollRef={modalScrollRef}
          dividerYRef={unseen.dividerYRef}
          hidePill={inVirtualTranscript ? undefined : false}
          newMessageCount={inVirtualTranscript ? 0 : newMessageCount}
          onPillClick={inVirtualTranscript ? onTranscriptPillClick : onPillClick}
          scrollable={
            inVirtualTranscript ? transcriptBody : (
              <TranscriptSwap
                lead={transcriptBody}
                tools={mergedTools}
                commands={commands}
                screen={screen}
                agentDefinitions={agentDefinitions}
                scrollRef={scrollRef}
                showAllInTranscript={showAllInTranscript}
              />
            )
          }
          bottom={
            <Box flexDirection="column">
              {}
              <Box flexDirection={isCompact ? "column-reverse" : "column"}>
                <MercuryFrame model={focusedEffectiveModel} />
                <CockpitBottomStatus>{workingStatusStrip}</CockpitBottomStatus>
              </Box>
              {}
              {!isCompact ? <FocusedSessionStatusRow /> : null}
              {bottomImmediateJsx}
              {focusedBottomDialog}
              {showExitFlow ? (
                <ExitFlow
                  onDone={() => setShowExitFlow(false)}
                  onCancel={() => setShowExitFlow(false)}
                  showWorktree={getCurrentWorktreeSession() !== null}
                />
              ) : null}
              {exitCommandJsx}
              {bottomSlot}
              {messageSelector}
            </Box>
          }
        />
      </ChatKeys>
    </KeybindingSetup>
  );

  fluxWhy('repl-root', rootWhyRef, () => ({
    focusedConnector,
    seatLive,
    focusedEffectiveModel,
    textActive,
    interruptingKey,
    isLoading,
    columns,
    rows,
    tokens,
    themeName,
    engineModel,
    pendingModelSwitch,
    mcpState,
    toolPermissionContext,
    agentDefinitions,
    verbose,
    spinnerTip,
    prefersReducedMotion,
    sessionAsks,
    chatSurfaceCovered,
    elicitationQueue,
    landing,
    armedMessage,
    sessionTitleSetting,
    warmthVersion,
    slotHasSession,
    messages,
    unseenDivider,
    newMessageCount,
    viewStreamMode,
    dumpMode,
    addNotification,
    removeNotification,
  }));
  if (!fullscreen) return tree;
  return <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{tree}</AlternateScreen>;
}
