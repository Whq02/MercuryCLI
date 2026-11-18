
import { join } from 'node:path';
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { type Command } from '../commands.js';
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
import { publishMcpConnections } from '../utils/cockpit/mcpGauge.js';
import { useAgentNeedsYou } from '../hooks/useAgentNeedsYou.js';
import { useMcpConnectivityStatus } from '../hooks/notifs/useMcpConnectivityStatus.js';
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js';
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js';
import { CockpitBottomStatus } from '../context/cockpitActiveContext.js';
import { MercuryFrame } from '../components/MercuryFrame.js';
import { useNotifications } from '../context/notifications.js';
import { currentSurfaceRoute, subscribeSurfaceRoute } from '../context/surfaceRoute.js';
import { useApiKeyVerification } from '../hooks/useApiKeyVerification.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useMergedCommands } from '../hooks/useMergedCommands.js';
import { useMergedTools } from '../hooks/useMergedTools.js';
import { useTurnEndPing } from '../hooks/useTurnEndPing.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { Box, Text, useTheme } from '../ink.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import { streamingRevealSuppressed } from '../ink/session/capabilities.js';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { getShortcutDisplay } from '../keybindings/shortcutFormat.js';
import { hasSeatLive, IDLE_LIVE, type SessionLiveV1 } from '../services/engine-connector/seatLive.js';
import { useFocusedTailAnchor, useFocusedTranscript } from '../hooks/useFocusedTranscript.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { getFocusedSessionConnector, hasFocusedSession, subscribeFocusedSessionConnector, subscribeThroughFocused, conversationIdHere } from '../services/engine-connector/focusedConnector.js';
import { flagEnv } from '../substrate/flagRegistry.js';
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js';
import type { Tool } from '../Tool.js';
import { ChatKeys } from './chat/ChatKeys.js';
import type { FocusedInputDialog } from './chat/focusedDialog.js';
import type { Screen as ScreenName } from './chat/screen.js';
import { useChatAsks, useChatAsksCard } from './chat/useChatAsks.js';
import { useChatBootLines, useChatBootNotices, useChatBootStart, useChatBootTips, useChatCrashResume } from './chat/useChatBoot.js';
import { type ToolJSXState, useChatDialogPaints, useChatDialogs, useChatDialogsView } from './chat/useChatDialogs.js';
import { useChatDraft } from './chat/useChatDraft.js';
import { useChatScroll, useChatScrollFollow, useChatScrollPin } from './chat/useChatScroll.js';
import { TranscriptFooter, TranscriptSearchBar, useChatSearch } from './chat/useChatSearch.js';
import { useChatSelector, useChatSelectorView } from './chat/useChatSelector.js';
import { useChatConversation, useChatSession } from './chat/useChatSession.js';
import { useChatSeatClock, useChatStatusStrip, useChatTurnBoundary, useChatTurnEnd, useChatTurnSignals } from './chat/useChatStatus.js';
import { useChatReceipts, useChatSubmit, useChatSubmitTools } from './chat/useChatSubmit.js';
import { AnimatedTitle, useChatTitle } from './chat/useChatTitle.js';
import { setCrashConversationLocator } from '../utils/crashReport.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../utils/fullscreen.js';
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

  const { paintScreenRow } = useChatReceipts({ addNotification });
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
  const { submitCount, setSubmitCount, getReadFileState, getToolUseContext, resume, paintScreenCommandReceipt, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef } = useChatSubmitTools({ store, setAppState, addNotification, removeNotification, debug, mergedTools, themeName, commandsRef, apiKeyVerification, paintScreenRow, setToolJSX, setShowMessageSelector, setConversationId });

  const { lastCompletedAt } = useChatTurnEnd({ focusedConnector, isLoading, setAppState, themeName, getReadFileState, seatPausedMsRef, seatPauseStartRef });


  useChatBootLines({ focusedConnector, addNotification });

  const { dialogSlotRef, dialogPaints, localJsx, compactDetailUp, dialogOwnsKeys } = useChatDialogPaints({ toolJSX, compactFocus, compactWork, fullscreen, chatSurfaceCovered, focusedInputDialog });
  const { onSubmit, onCancel, landing, armedMessage } = useChatSubmit({ addNotification, setAppState, setInputValue, setInputMode, setPastedContents, authWallHold, repinToBottom, setToolJSX, toolJSX, getToolUseContext, paintScreenCommandReceipt, setSubmitCount, lastCompletedAt, commandsRef, isLoadingRef, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef, getFocusedSeatLive });

  useChatBootStart({ submitCount, addNotification, removeNotification });

  useChatTurnSignals({ isLoading, textActive, toolUseConfirmQueue, messages });

  useChatBootNotices({ focusedConnector, addNotification, removeNotification, focusedInputDialog, setCrashResumeStaged, crashNoticeLatchedRef, apiKeyVerification, engineModel });

  const { title, titleAnimating, sessionTitleSetting } = useChatTitle({ focusedInputDialog, focusedConnector, isLoading, store });

  useTurnEndPing({ lastCompletedAt, busy: isLoading });

  const { centredModalUp, toolJSXRef, centredModal, bottomImmediateJsx, inlineToolJsx, focusedBottomDialog } = useChatDialogsView({ toolJSX, dialogSlotRef, localJsx, compactDetailUp, setShowCostThreshold, messages, fullscreen, compactWork, getToolUseContext, focusedEffectiveModel, chatSurfaceCovered, focusedInputDialog, elicitationQueue, respondToElicitation, dismissElicitationWaiting, crashResumeStaged, setCrashResumeStaged, addNotification, removeNotification, store });

  useChatBootTips({ fullscreen, addNotification });

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
