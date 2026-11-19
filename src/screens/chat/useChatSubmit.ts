import type { UUID } from 'node:crypto';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { commandOffInPlainWorld, commandSeat, getCommandName, isCommandEnabled, type Command, type ResumeEntrypoint } from '../../commands.js';
import { HELD_FOR_COMPACTION_LINE } from '../../components/messages/TranscriptNameplate.js';
import { LOCAL_COMMAND_STDOUT_TAG } from '../../constants/xml.js';
import type { useNotifications } from '../../context/notifications.js';
import { performUiRouteAlias } from '../../context/routeAliases.js';
import { addToHistory, expandPastedTextRefs, resolvePastedContents } from '../../history.js';
import type { useApiKeyVerification } from '../../hooks/useApiKeyVerification.js';
import type { useAuthWallHold } from '../../hooks/useAuthWallHold.js';
import { interruptFocusedTurn } from '../../hooks/useCancelRequest.js';
import type { useMergedTools } from '../../hooks/useMergedTools.js';
import { useSeatReceipts } from '../../hooks/useSeatReceipts.js';
import type { useTheme } from '../../ink.js';
import * as pendingInput from '../../input-core/pending-input.js';
import { query } from '../../query.js';
import { getFocusedSessionConnector, hasFocusedSession, landingInFlight, subscribeFocusedSessionConnector } from '../../services/engine-connector/focusedConnector.js';
import type { SessionLiveV1 } from '../../services/engine-connector/seatLive.js';
import { useAppState, type useAppStateStore, type useSetAppState } from '../../state/AppState.js';
import type { AppState } from '../../state/AppStateStore.js';
import type { SetToolJSXFn } from '../../Tool.js';
import type { SessionListing } from '../../types/logs.js';
import type { Message, UserMessage } from '../../types/message.js';
import type { PromptInputHelpers } from '../../types/promptInputHelpers.js';
import type { PromptInputMode } from '../../types/textInputTypes.js';
import { createAbortController } from '../../utils/abortController.js';
import { isSettingsPopupOpen } from '../../utils/cockpit/settingsPopup.js';
import type { PastedContent } from '../../utils/config/schema.js';
import { logForDebugging } from '../../utils/debug.js';
import { createFileStateCacheWithSizeLimit, READ_FILE_STATE_CACHE_SIZE, type FileStateCache } from '../../utils/fileStateCache.js';
import { createCommandInputMessage, createUserMessage, getUserMessageText } from '../../utils/messages.js';
import { formatCommandLoadingMetadata, resolveUnknownSlashName, unavailableCommandLine, unknownCommandLine } from '../../utils/processUserInput/processSlashCommand.js';
import { submitTrace } from '../../utils/submitTrace.js';
import { RECEIPT_TIMEOUT_MS, SWITCH_STATUS_TIMEOUT_MS } from './limits.js';
import type { PaintsRows, ResumableLog } from './sessionShapes.js';
import type { ToolJSXState } from './useChatDialogs.js';

const HELD_FOR_LANDING: ReadonlySet<string> = new Set(['swarm', 'swarmchat', 'general', 'team', 'whisper', 'rename', 'title', 'contract', 'crewmates']);

const INERT_PROMPT_HELPERS: PromptInputHelpers = {
  setCursorOffset: () => {},
  clearBuffer: () => {},
  resetHistory: () => {},
};

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

export function useChatReceipts({ addNotification }: { addNotification: ReturnType<typeof useNotifications>['addNotification'] }) {
  const paintScreenRow = useCallback((row: Message, fallbackText: string): void => {
    const focused = getFocusedSessionConnector() as PaintsRows;
    if (typeof focused.addDisplayRow === 'function') {
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
  return { onSubmit, onCancel, landing, armedMessage };
}
