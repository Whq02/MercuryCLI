import { featureReached } from '../../substrate/featureReached.js';
import type { UUID } from 'node:crypto';
import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { getCommandName, type Command, type ResumeEntrypoint } from '../../commands.js';
import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js';
import type { useNotifications } from '../../context/notifications.js';
import { useLoad, usePublish } from '../../hooks/effects.js';
import type { useApiKeyVerification } from '../../hooks/useApiKeyVerification.js';
import type { useAuthWallHold } from '../../hooks/useAuthWallHold.js';
import { interruptFocusedTurn } from '../../hooks/useCancelRequest.js';
import type { useMergedTools } from '../../hooks/useMergedTools.js';
import { useSeatReceipts } from '../../hooks/useSeatReceipts.js';
import type { useTheme } from '../../ink.js';
import { query } from '../../query.js';
import { getFocusedSessionConnector, landingInFlight, subscribeFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js';
import type { SessionLiveV1 } from '../../services/engine-connector/seatLive.js';
import { useAppState, type useAppStateStore, type useSetAppState } from '../../state/AppState.js';
import type { AppState } from '../../state/AppStateStore.js';
import type { SetToolJSXFn } from '../../Tool.js';
import type { SessionListing } from '../../types/logs.js';
import type { Message, UserMessage } from '../../types/message.js';
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js';
import type { PromptInputMode } from '../../types/textInputTypes.js';
import type { PastedContent } from '../../utils/config/schema.js';
import { logForDebugging } from '../../utils/debug.js';
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../../utils/fileStateCache.js';
import { createCommandInputMessage, createUserMessage, getUserMessageText } from '../../services/messages.js';
import { formatCommandLoadingMetadata } from '../../services/processUserInput/processSlashCommand.js';
import { submitTrace } from '../../utils/submitTrace.js';
import { RECEIPT_TIMEOUT_MS, SWITCH_STATUS_TIMEOUT_MS } from './limits.js';
import type { ResumableLog } from './sessionShapes.js';
import { openDialogCommand, queueBehindDialog } from './submit/dialogCommand.js';
import { followRouteAlias, holdCommandForLanding, readCommandArgs, runLocalCommand } from './submit/screenCommand.js';
import { holdForLanding, sendToSession } from './submit/sessionSend.js';
import { INERT_PROMPT_HELPERS, readSubmitLine, refuseUnknownSlash, takeComposer, type SubmitDeps, type SubmitOptions } from './submit/submitLine.js';
import type { ToolJSXState } from './useChatDialogs.js';

export function useChatReceipts({ addNotification }: { addNotification: ReturnType<typeof useNotifications>['addNotification'] }) {
  const paintScreenRow = useCallback((row: Message, fallbackText: string): void => {
    const focused = getFocusedSessionConnector();
    if (focused.addDisplayRow !== undefined) {
      focused.addDisplayRow(row);
      return;
    }
    addNotification({ key: `screen-row-${Date.now()}`, text: fallbackText, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }, [addNotification]);
  useSeatReceipts({
    setMessages: next => {
      const rows = typeof next === 'function' ? next([]) : next;
      for (const row of rows) paintScreenRow(row, '');
    },
  });
  return { paintScreenRow };
}

type SubmitToolsArgs = {
  store: ReturnType<typeof useAppStateStore>;
  setAppState: ReturnType<typeof useSetAppState>;
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  removeNotification: ReturnType<typeof useNotifications>['removeNotification'];
  debug: boolean;
  mergedTools: ReturnType<typeof useMergedTools>;
  themeName: ReturnType<typeof useTheme>[0];
  commandsRef: { current: Command[] };
  apiKeyVerification: ReturnType<typeof useApiKeyVerification>;
  paintScreenRow: (row: Message, fallbackText: string) => void;
  setToolJSX: SetToolJSXFn;
  setShowMessageSelector: (show: boolean) => void;
  setConversationId: (id: string) => void;
};

export function useChatSubmitTools({ store, setAppState, addNotification, removeNotification, debug, mergedTools, themeName, commandsRef, apiKeyVerification, paintScreenRow, setToolJSX, setShowMessageSelector, setConversationId }: SubmitToolsArgs) {
  const [submitCount, setSubmitCount] = useState(0);
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

  const resume = useCallback(async (sessionId: UUID, log: ResumableLog, entrypoint: ResumeEntrypoint): Promise<void> => {
    void entrypoint;
    const label = log.customTitle ?? log.agentName ?? String(sessionId).slice(0, 8);
    addNotification({
      key: 'session-switch',
      text: `opening ${label}…`,
      priority: 'medium',
      timeoutMs: SWITCH_STATUS_TIMEOUT_MS,
    });
    const { focusResumedSession } = await import('../../services/switchboard/hopIntoSession.js');
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

  const paintScreenCommandReceipt = useCallback((commandName: string, args: string, text: string, timestamp = new Date().toISOString()): void => {
    const focused = getFocusedSessionConnector();
    if (focused.addDisplayRow !== undefined) {
      focused.addDisplayRow({ ...createUserMessage({ content: formatCommandLoadingMetadata(commandName, args) }), timestamp });
      focused.addDisplayRow(createCommandInputMessage(`<${LOCAL_COMMAND_STDOUT_TAG}>${text}</${LOCAL_COMMAND_STDOUT_TAG}>`));
      return;
    }
    addNotification({ key: `command-${commandName}`, text, priority: 'immediate', timeoutMs: RECEIPT_TIMEOUT_MS });
  }, [addNotification]);
  const dialogInFlightRef = useRef<{ name: string; mounted: boolean } | null>(null);
  const armedHandedBackRef = useRef<{ text: string; pastedContents: Record<number, PastedContent> } | null>(null);
  const queuedDialogCommandsRef = useRef<Array<{ input: string; name: string; submittedAt: string; pastedContents: Record<number, PastedContent> }>>([]);
  return { submitCount, setSubmitCount, getReadFileState, getToolUseContext, resume, paintScreenCommandReceipt, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef };
}

type SubmitTools = ReturnType<typeof useChatSubmitTools>;
type SubmitArgs = {
  addNotification: ReturnType<typeof useNotifications>['addNotification'];
  setAppState: ReturnType<typeof useSetAppState>;
  setInputValue: (value: string) => void;
  setInputMode: (mode: PromptInputMode) => void;
  setPastedContents: (next: Record<number, PastedContent>) => void;
  authWallHold: ReturnType<typeof useAuthWallHold>;
  repinToBottom: () => void;
  setToolJSX: SetToolJSXFn;
  toolJSX: ToolJSXState;
  getToolUseContext: SubmitTools['getToolUseContext'];
  paintScreenCommandReceipt: SubmitTools['paintScreenCommandReceipt'];
  setSubmitCount: SubmitTools['setSubmitCount'];
  lastCompletedAt: number | null;
  commandsRef: { current: Command[] };
  isLoadingRef: { current: boolean };
  dialogInFlightRef: SubmitTools['dialogInFlightRef'];
  armedHandedBackRef: SubmitTools['armedHandedBackRef'];
  queuedDialogCommandsRef: SubmitTools['queuedDialogCommandsRef'];
  getFocusedSeatLive: () => SessionLiveV1;
};

export function useChatSubmit({ addNotification, setAppState, setInputValue, setInputMode, setPastedContents, authWallHold, repinToBottom, setToolJSX, toolJSX, getToolUseContext, paintScreenCommandReceipt, setSubmitCount, lastCompletedAt, commandsRef, isLoadingRef, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef, getFocusedSeatLive }: SubmitArgs) {
  const drainQueuedDialogCommand = useCallback((): void => {
    const next = queuedDialogCommandsRef.current.shift();
    if (next === undefined) return;
    void onSubmitRef.current(next.input, INERT_PROMPT_HELPERS, undefined, { rearmed: true, submittedAt: next.submittedAt, pastedContents: next.pastedContents });
  }, []);
  const onSubmit = useCallback(async (input: string, helpers: PromptInputHelpers, _speculationAccept?: unknown, options?: SubmitOptions): Promise<void> => {
    const submittedAt = options?.submittedAt ?? new Date().toISOString();
    const text = input.trim();
    if (text === '') return;
    submitTrace('repl-onSubmit', input, { fromKeybinding: options?.fromKeybinding === true, speculation: false, guardActive: isLoadingRef.current });
    const deps: SubmitDeps = { addNotification, setAppState, setInputValue, setInputMode, setPastedContents, authWallHold, repinToBottom, setToolJSX, getToolUseContext, paintScreenCommandReceipt, setSubmitCount, commandsRef, isLoadingRef, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef, getFocusedSeatLive, drainQueuedDialogCommand, onSubmitRef };
    const line = readSubmitLine(deps, input, helpers, options, submittedAt, text);
    const { seatCommand } = line;
    if (refuseUnknownSlash(deps, line)) return;
    if (line.seat === 'session') {
      if (holdForLanding(deps, line)) return;
      const sent = sendToSession(deps, line);
      if (options?.armedMode !== undefined) await sent;
      return;
    }
    const commandArgs = readCommandArgs(line);
    if (holdCommandForLanding(deps, line, commandArgs)) return;
    if (seatCommand !== undefined && seatCommand.type === 'local' && seatCommand.uiRouteAlias === undefined) {
      takeComposer(deps, line);
      const ran = runLocalCommand(deps, line, seatCommand, commandArgs);
      if (options?.armedMode !== undefined) await ran;
      return;
    }
    const routeAlias = (seatCommand as { uiRouteAlias?: 'concourse' } | undefined)?.uiRouteAlias;
    if (seatCommand !== undefined && routeAlias) {
      followRouteAlias(deps, line, routeAlias);
      return;
    }
    if (seatCommand !== undefined && seatCommand.type === 'local-jsx') {
      const dialogName = getCommandName(seatCommand);
      if (queueBehindDialog(deps, line, dialogName)) return;
      const { spaceAt, argsWithPastes } = commandArgs;
      const { context, onDone, mountDialog, failDialog } = openDialogCommand(deps, line, seatCommand, dialogName, commandArgs);
      try {
        const module = await seatCommand.load();
        featureReached('command', seatCommand.name);
        const element = await module.call(onDone, context, await argsWithPastes(), text.slice(1, spaceAt === -1 ? undefined : spaceAt));
        mountDialog(element);
      } catch (error) {
        failDialog(error);
      }
    }
  }, [addNotification, authWallHold, drainQueuedDialogCommand, getToolUseContext, lastCompletedAt, paintScreenCommandReceipt, repinToBottom, setInputMode, setInputValue, setPastedContents, setToolJSX]);
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  usePublish(() => {
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
  useLoad(() => {
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
          const detail = error instanceof Error ? error.message : String(error);
          logForDebugging(`a line armed for the landing was not submitted: ${detail}`);
          addNotification({
            key: 'armed-submit-failed',
            text: `Could not send the queued message (${detail}) — type it again.`,
            priority: 'high',
            color: 'error' as const,
            timeoutMs: RECEIPT_TIMEOUT_MS,
          });
        }
      }
      armedHandedBackRef.current = null;
    })();
  }, [armedMessage, landing, setAppState, addNotification]);
  return { onSubmit, onCancel, landing, armedMessage };
}
