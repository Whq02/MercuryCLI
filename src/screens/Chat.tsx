
import { join } from 'node:path';
import React, { useRef, useState, useSyncExternalStore } from 'react';
import { type Command } from '../commands.js';
import { useLayoutChrome } from '../context/layoutChromeContext.js';
import { useCompactWorkControls } from '../components/tasks/CompactWorkSummary.js';
import { useAgentNeedsYou } from '../hooks/useAgentNeedsYou.js';
import { fluxMark, fluxWhy } from '../utils/flux/fluxProbe.js';
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js';
import { useNotifications } from '../context/notifications.js';
import { currentSurfaceRoute, subscribeSurfaceRoute } from '../context/surfaceRoute.js';
import { useEngineModel } from '../hooks/useEngineModel.js';
import { useTurnEndPing } from '../hooks/useTurnEndPing.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { useTheme } from '../ink.js';
import { AlternateScreen } from '../ink/components/AlternateScreen.js';
import { streamingRevealSuppressed } from '../ink/session/capabilities.js';
import { useFocusedTailAnchor, useFocusedTranscript } from '../hooks/useFocusedTranscript.js';
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js';
import { getFocusedSessionConnector, hasFocusedSession, conversationIdHere } from '../services/engine-connector/focusedConnector.js';
import { flagEnv } from '../substrate/flagRegistry.js';
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js';
import type { Tool } from '../Tool.js';
import { useChatAsks, useChatAsksCard } from './chat/useChatAsks.js';
import { useChatBootLines, useChatBootNotices, useChatBootStart, useChatBootTips, useChatCrashResume } from './chat/useChatBoot.js';
import { type ToolJSXState, useChatDialogPaints, useChatDialogs, useChatDialogsView } from './chat/useChatDialogs.js';
import { useChatDraft } from './chat/useChatDraft.js';
import { useChatScroll, useChatScrollFollow, useChatScrollPin } from './chat/useChatScroll.js';
import { useChatSearch } from './chat/useChatSearch.js';
import { useChatSelector, useChatSelectorView } from './chat/useChatSelector.js';
import { useChatConversation, useChatSession } from './chat/useChatSession.js';
import { useChatSeatClock, useChatStatusStrip, useChatTurnBoundary, useChatTurnEnd, useChatTurnSignals } from './chat/useChatStatus.js';
import { useChatReceipts, useChatSubmit, useChatSubmitTools } from './chat/useChatSubmit.js';
import { useChatTitle } from './chat/useChatTitle.js';
import { setCrashConversationLocator } from '../utils/crashReport.js';
import { getProjectDir } from '../utils/sessionStoragePortable.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../utils/fullscreen.js';
import { chatBottomSlot } from './chat/chatBottomSlot.js';
import { chatMessagesList, chatTranscriptBody } from './chat/chatMessagesList.js';
import { chatLegacyTree, chatTree } from './chat/chatTree.js';
import type { FocusedInputDialog } from './chat/focusedDialog.js';
import type { Screen as ScreenName } from './chat/screen.js';
import { getFocusedSeatLive, useChatFocusedSeat } from './chat/useChatFocusedSeat.js';
import { useChatTools } from './chat/useChatTools.js';

export type Screen = ScreenName;

export type Props = {
  commands: Command[];
  debug?: boolean;
  initialTools: Tool[];
  disabled?: boolean;
  disableSlashCommands?: boolean;
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

  const { focusedConnector, seatLive, focusedEffectiveModel, textActive, interruptingKey, isStopping, focusedTail, isLoading, isLoadingRef } = useChatFocusedSeat();

  const { pendingModelSwitch } = useChatTurnBoundary({ isLoading, setAppState, addNotification });

  const messages = useFocusedTranscript();
  const tailAnchor = useFocusedTailAnchor();
  const { conversationId, setConversationId } = useChatConversation(focusedConnector);
  const { toolJSX, setToolJSX, isExiting, showExitFlow, setShowExitFlow, exitCommandJsx, showCostThreshold, setShowCostThreshold, showBashesDialog, setShowBashesDialog, handleExit } = useChatDialogs({ store, addNotification });
  const { showMessageSelector, setShowMessageSelector, openMessageSelector, messageSelectorPreselect, setMessageSelectorPreselect } = useChatSelector();
  const { crashResumeStaged, setCrashResumeStaged, crashNoticeLatchedRef } = useChatCrashResume();

  const { mcpState, toolPermissionContext, agentDefinitions, verbose, spinnerTip, commands, mergedTools, commandsRef, apiKeyVerification } = useChatTools({ initialCommands, initialTools });

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

  const bottomSlot = chatBottomSlot({ isExiting, showExitFlow, toolJSX, showBashesDialog, setShowBashesDialog, handleExit, toolPermissionContext, apiKeyVerification, commands, agentDefinitions, verbose, setToolPermissionContext, submitCount, getToolUseContext, openMessageSelector, messageActionsDisabled, messageActions, messageCursorActive, vimMode, setVimMode, isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen, insertTextRef, onSubmit, dialogPaints, inTranscript, searchBarOpen, previewSearch, commitSearch, cancelSearch, warmSearchIndex, searchMatchCount, searchMatchCurrent, committedSearchQuery, inVirtualTranscript, dumpMode, showAllInTranscript, editorStatus, disabled, debug, disableSlashCommands, focusedInputDialog, compactWork, compactFocus, isLoading, dialogsHiddenWhileTyping, columns });

  const messagesList = chatMessagesList({ inVirtualTranscript, inTranscript, screen, showAllInTranscript, jumpRef, onSearchMatchesChange, scanElement, setPositions, dumpMode, displayedMessages, paintedMessages, mergedTools, commands, agentDefinitions, verbose, viewInProgressToolUseIDs, conversationId, isLoading, focusedTail, scrollRef, showMessageSelector, toolJSX, toolUseConfirmQueue, unseenDivider, messageNavRef, streamingSuppressed, messages, tailAnchor });

  const transcriptBody = chatTranscriptBody({ inVirtualTranscript, entryLoadingLine, inlineToolJsx, messagesList });

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
    return chatLegacyTree({ title, titleAnimating, toolJSX, dumpMode, showAllInTranscript, editorStatus, terminalTitleEnabled, keys, messagesList });
  }

  const tree = chatTree({ title, titleAnimating, scrollRef, modalScrollRef, workingStatusStrip, spinnerSlotReserved, permissionOverlay, centredModalUp, centredModal, bottomImmediateJsx, focusedBottomDialog, dialogOwnsKeys, unseen, newMessageCount, onPillClick, inVirtualTranscript, onTranscriptPillClick, screen, showAllInTranscript, mergedTools, commands, agentDefinitions, showExitFlow, setShowExitFlow, exitCommandJsx, messageSelector, terminalTitleEnabled, keys, transcriptBody, isCompact, focusedEffectiveModel, bottomSlot });

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
