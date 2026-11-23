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
import { useChatScreenStore } from './chat/chatStore.js';
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
import { passedOver } from '../utils/passedOver.js';
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
  initialTools: Tool[];
  debug?: boolean;
  disabled?: boolean;
  disableSlashCommands?: boolean;
};

setCrashConversationLocator(() => {
  const sessionId = conversationIdHere();
  let transcriptPath: string | null = null;
  if (hasFocusedSession()) {
    try {
      const workspace = getFocusedSessionConnector().workspace();
      const projectRoot = workspace.projectRoot || workspace.originalCwd || workspace.cwd;
      if (projectRoot) {
        transcriptPath = join(getProjectDir(projectRoot), `${sessionId}.jsonl`);
      }
    } catch (error) {
      passedOver(error);
      transcriptPath = null;
    }
  }
  return { sessionId, transcriptPath };
});

function selectFocusedInputDialog({
  exiting,
  showMessageSelector,
  isPromptInputActive,
  toolJSX,
  toolUseConfirmCount,
  elicitationCount,
  showCostThreshold,
  hasCrashResume,
}: {
  exiting: boolean;
  showMessageSelector: boolean;
  isPromptInputActive: boolean;
  toolJSX: ToolJSXState;
  toolUseConfirmCount: number;
  elicitationCount: number;
  showCostThreshold: boolean;
  hasCrashResume: boolean;
}): FocusedInputDialog | undefined {
  if (exiting) return undefined;
  if (showMessageSelector) return 'message-selector';
  if (isPromptInputActive) return undefined;
  if (toolJSX !== null && !toolJSX.shouldContinueAnimation) return undefined;
  if (toolUseConfirmCount > 0) return 'tool-permission';
  if (elicitationCount > 0) return 'elicitation';
  if (showCostThreshold) return 'cost-threshold';
  if (hasCrashResume) return 'crash-resume';
  return undefined;
}

export function Chat({ commands: initialCommands, initialTools, debug = false, disabled = false, disableSlashCommands = false }: Props): React.ReactNode {
  if (flagEnv('MERCURY_RENDER_FAULT') === 'chat') {
    throw new Error('deterministic Chat render fault (MERCURY_RENDER_FAULT=chat)');
  }

  fluxMark('render:chat-root');

  const [fullscreen] = useState(() => isFullscreenEnvEnabled());
  const [terminalExperience] = useState(() => resolveTerminalExperience());
  const virtualScrollEnabled = terminalExperience.virtualScroll.effective;
  const terminalTitleEnabled = terminalExperience.terminalTitle.effective;

  const { columns, rows } = useTerminalSize();
  const { isCompact } = useLayoutChrome();
  const [themeName] = useTheme();
  const tokens = useMercuryTokens();
  const store = useAppStateStore();
  const setAppState = useSetAppState();
  const { addNotification, removeNotification } = useNotifications();
  const surfaceRoute = useSyncExternalStore(subscribeSurfaceRoute, currentSurfaceRoute, currentSurfaceRoute);
  const chatSurfaceCovered = surfaceRoute.kind !== 'repl';
  const reducedMotionSetting = useAppState(state => state.settings.view?.reducedMotion === true);
  const reducedMotion = reducedMotionSetting || isEnvTruthy(flagEnv('MERCURY_REDUCED_MOTION'));
  const streamingSuppressed = streamingRevealSuppressed(reducedMotion, fullscreen);
  const engineModel = useEngineModel();
  const chatStore = useChatScreenStore();
  const { controls: compactWork, focus: compactFocus } = useCompactWorkControls();

  const { focusedConnector, seatLive, focusedEffectiveModel, textActive, interruptingKey, isStopping, focusedTail, isLoading, isLoadingRef } = useChatFocusedSeat();
  const messages = useFocusedTranscript();
  const tailAnchor = useFocusedTailAnchor();
  const { conversationId, setConversationId } = useChatConversation(focusedConnector);
  const { toolPermissionContext, agentDefinitions, verbose, spinnerTip, commands, mergedTools, commandsRef, apiKeyVerification } = useChatTools({ initialCommands, initialTools });
  const { crashResumeStaged, setCrashResumeStaged, crashNoticeLatchedRef } = useChatCrashResume();
  const { toolUseConfirmQueue, resolvedConsentCount, resolveHeadPermission, setToolPermissionContext, elicitationQueue, respondToElicitation, dismissElicitationWaiting } = useChatAsks({ setAppState, addNotification, chatStore });
  const { toolJSX, setToolJSX, isExiting, showExitFlow, setShowExitFlow, exitCommandJsx, showCostThreshold, setShowCostThreshold, showBashesDialog, setShowBashesDialog, handleExit } = useChatDialogs({ store, addNotification });
  const { showMessageSelector, setShowMessageSelector, openMessageSelector, messageSelectorPreselect, setMessageSelectorPreselect } = useChatSelector();
  const { scrollRef, scrollRestoreRef, modalScrollRef, lastUserScrollAtRef, repinToBottom, noteUserScroll } = useChatScrollPin();
  const { isPromptInputActive, setInputValue, setInputMode, setPastedContents, authWallHold, insertTextRef, vimMode, setVimMode, isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen } = useChatDraft({ messages, fullscreen, repinToBottom, lastUserScrollAtRef });

  const focusedInputDialog = selectFocusedInputDialog({
    exiting: isExiting || showExitFlow,
    showMessageSelector,
    isPromptInputActive,
    toolJSX,
    toolUseConfirmCount: toolUseConfirmQueue.length,
    elicitationCount: elicitationQueue.length,
    showCostThreshold,
    hasCrashResume: crashResumeStaged !== null,
  });
  const dialogsHiddenWhileTyping = isPromptInputActive && !isExiting && !showMessageSelector && (toolUseConfirmQueue.length > 0 || showCostThreshold);

  const { dialogSlotRef, dialogPaints, localJsx, compactDetailUp, dialogOwnsKeys } = useChatDialogPaints({ toolJSX, compactFocus, compactWork, fullscreen, chatSurfaceCovered, focusedInputDialog });
  const { unseen, captureScrollForFlip, setFlipGeneration, unseenDivider, newMessageCount, onScroll, onPillClick } = useChatScroll({ messages, fullscreen, scrollRef, scrollRestoreRef, noteUserScroll });
  useChatScrollFollow({ messages, repinToBottom });
  const { screen, setScreen, showAllInTranscript, setShowAllInTranscript, dumpMode, searchBarOpen, committedSearchQuery, searchMatchCount, searchMatchCurrent, editorStatus, inVirtualTranscriptMode, inTranscript, inVirtualTranscript, legacyTranscript, handleEnterTranscript, handleExitTranscript, previewSearch, commitSearch, cancelSearch, warmSearchIndex, onSearchMatchesChange, onTranscriptScroll, onTranscriptPillClick, jumpRef, scanElement, setPositions, transcriptMessages } = useChatSearch({ fullscreen, virtualScrollEnabled, columns, mergedTools, messages, focusedInputDialog, captureScrollForFlip, setFlipGeneration, scrollRef, scrollRestoreRef, onScroll });

  const { paintScreenRow } = useChatReceipts({ addNotification });
  const { submitCount, setSubmitCount, getReadFileState, getToolUseContext, resume, paintScreenCommandReceipt, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef } = useChatSubmitTools({ store, setAppState, addNotification, removeNotification, debug, mergedTools, themeName, commandsRef, apiKeyVerification, paintScreenRow, setToolJSX, setShowMessageSelector, setConversationId });

  useChatTurnBoundary({ isLoading, setAppState, addNotification });
  const { seatStartTimeRef, seatPausedMsRef, seatPauseStartRef } = useChatSeatClock({ seatLive, focusedInputDialog, isLoading });
  const { lastCompletedAt } = useChatTurnEnd({ focusedConnector, isLoading, setAppState, themeName, getReadFileState, seatPausedMsRef, seatPauseStartRef });
  useTurnEndPing({ lastCompletedAt, busy: isLoading });
  useChatTurnSignals({ isLoading, textActive, toolUseConfirmQueue, messages });
  useAgentNeedsYou(messages, isLoading);
  const { viewInProgressToolUseIDs, viewStreamMode, spinnerSlotReserved, workingStatusStrip } = useChatStatusStrip({ seatLive, messages, toolJSX, toolUseConfirmQueue, isLoading, isStopping, textActive, streamingSuppressed, isCompact, focusedConnector, spinnerTip, verbose, seatStartTimeRef, seatPausedMsRef, seatPauseStartRef });
  const { title, titleAnimating } = useChatTitle({ focusedInputDialog, focusedConnector, isLoading, store });

  const { onSubmit, onCancel, landing, armedMessage } = useChatSubmit({ addNotification, setAppState, setInputValue, setInputMode, setPastedContents, authWallHold, repinToBottom, setToolJSX, toolJSX, getToolUseContext, paintScreenCommandReceipt, setSubmitCount, lastCompletedAt, commandsRef, isLoadingRef, dialogInFlightRef, armedHandedBackRef, queuedDialogCommandsRef, getFocusedSeatLive });

  const { permissionOverlay } = useChatAsksCard({ focusedInputDialog, repinToBottom, toolUseConfirmQueue, resolvedConsentCount, chatStore, resolveHeadPermission, chatSurfaceCovered, verbose });
  const { centredModalUp, toolJSXRef, centredModal, bottomImmediateJsx, inlineToolJsx, focusedBottomDialog } = useChatDialogsView({ toolJSX, dialogSlotRef, localJsx, compactDetailUp, setShowCostThreshold, messages, fullscreen, compactWork, getToolUseContext, focusedEffectiveModel, chatSurfaceCovered, focusedInputDialog, elicitationQueue, respondToElicitation, dismissElicitationWaiting, crashResumeStaged, setCrashResumeStaged, addNotification, removeNotification, store });
  const { paintedMessages, entryLoadingLine, displayedMessages } = useChatSession({ focusedConnector, messages, compactWork, unseen, repinToBottom, setConversationId, setToolJSX, toolJSXRef, localJsx, landing, armedMessage, chatSurfaceCovered, inVirtualTranscript, transcriptMessages });
  const { messageActionsDisabled, messageCursorActive, messageNavRef, messageActions, messageSelector } = useChatSelectorView({ addNotification, setInputValue, setInputMode, setShowMessageSelector, messageSelectorPreselect, setMessageSelectorPreselect, focusedInputDialog, chatSurfaceCovered, messages, onCancel, focusedEffectiveModel, handleEnterTranscript, setScreen, setShowAllInTranscript, isLoadingRef, resume });

  useChatBootLines({ focusedConnector, addNotification });
  useChatBootStart({ submitCount, addNotification, removeNotification });
  useChatBootNotices({ focusedConnector, addNotification, removeNotification, focusedInputDialog, setCrashResumeStaged, crashNoticeLatchedRef, apiKeyVerification, engineModel });
  useChatBootTips({ fullscreen, addNotification });

  const whyRef = useRef<Record<string, unknown> | null>(null);
  fluxWhy('repl-root', whyRef, () => ({
    focusedConnector, seatLive, columns, rows, themeName, tokens, focusedEffectiveModel,
    toolPermissionContext, focusedInputDialog, toolJSX, isLoading, isStopping, textActive,
    interruptingKey, viewStreamMode, messages, displayedMessages, screen, fullscreen, isCompact, chatSurfaceCovered,
  }));

  const bottomSlot = chatBottomSlot({
    isExiting, showExitFlow, toolJSX, showBashesDialog, setShowBashesDialog, handleExit,
    toolPermissionContext, apiKeyVerification, commands, agentDefinitions, verbose,
    setToolPermissionContext, submitCount, getToolUseContext, openMessageSelector,
    messageActionsDisabled, messageActions, messageCursorActive,
    vimMode, setVimMode, isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen, insertTextRef,
    onSubmit, dialogPaints, inTranscript, searchBarOpen, previewSearch, commitSearch, cancelSearch,
    warmSearchIndex, searchMatchCount, searchMatchCurrent, committedSearchQuery,
    inVirtualTranscript, dumpMode, showAllInTranscript, editorStatus,
    disabled, debug, disableSlashCommands, focusedInputDialog, compactWork, compactFocus,
    isLoading, dialogsHiddenWhileTyping, columns,
  });

  const messagesList = chatMessagesList({
    inVirtualTranscript, inTranscript, screen, showAllInTranscript, jumpRef, onSearchMatchesChange,
    scanElement, setPositions, dumpMode, displayedMessages, paintedMessages, mergedTools, commands,
    agentDefinitions, verbose, viewInProgressToolUseIDs, conversationId, isLoading, focusedTail,
    scrollRef, showMessageSelector, toolJSX, toolUseConfirmQueue, unseenDivider, messageNavRef,
    streamingSuppressed, messages, tailAnchor,
  });

  const transcriptBody = chatTranscriptBody({ inVirtualTranscript, entryLoadingLine, inlineToolJsx, messagesList });

  const keys = {
    legacyTranscript, fullscreen, compactWork, screen, setScreen, showAllInTranscript, setShowAllInTranscript,
    messages, handleEnterTranscript, handleExitTranscript, inVirtualTranscriptMode, inVirtualTranscript,
    searchBarOpen, helpOpen, isSearchingHistory, messageCursorActive, messageActions, messageActionsDisabled,
    focusedInputDialog, toolUseConfirmQueue, showMessageSelector, showBashesDialog, vimMode,
    dialogOwnsKeys, centredModalUp, permissionOverlay, viewStreamMode, seatLive,
    onSubmit, commands, scrollRef, modalScrollRef, onScroll, onTranscriptScroll,
  };

  if (legacyTranscript) {
    return chatLegacyTree({ title, titleAnimating, toolJSX, dumpMode, showAllInTranscript, editorStatus, terminalTitleEnabled, keys, messagesList });
  }

  const tree = chatTree({
    title, titleAnimating, scrollRef, modalScrollRef, workingStatusStrip, spinnerSlotReserved,
    permissionOverlay, centredModalUp, centredModal, bottomImmediateJsx, focusedBottomDialog,
    dialogOwnsKeys, unseen, newMessageCount, onPillClick, inVirtualTranscript, onTranscriptPillClick,
    screen, showAllInTranscript, mergedTools, commands, agentDefinitions, showExitFlow, setShowExitFlow,
    exitCommandJsx, messageSelector, terminalTitleEnabled, keys, transcriptBody, isCompact,
    focusedEffectiveModel, bottomSlot,
  });

  return fullscreen ? <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{tree}</AlternateScreen> : tree;
}
