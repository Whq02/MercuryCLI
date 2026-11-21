import React, { useState } from 'react';
import { MessageActionsKeybindings } from '../../components/messageActions.js';
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js';
import { isVimModeEnabled } from '../../components/PromptInput/utils.js';
import { ScrollKeybindingHandler } from '../../components/ScrollKeybindingHandler.js';
import type { SpinnerMode } from '../../types/spinner.js';
import { SwitchboardAttributionProvider } from '../../components/SwitchboardTagBar.js';
import type { CompactWorkControls } from '../../components/tasks/CompactWorkSummary.js';
import { CancelRequestHandler } from '../../hooks/useCancelRequest.js';
import { CommandKeybindingHandlers } from '../../hooks/useCommandKeybindings.js';
import { useHoldsEscape } from '../../hooks/useEscapeOwned.js';
import { GlobalKeybindingHandlers } from '../../hooks/useGlobalKeybindings.js';
import { useClaim } from '../../hooks/effects.js';
import type { VimMode } from '../../hooks/useVimInput.js';
import { useStdin } from '../../ink.js';
import type { ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import type { SessionLiveV1 } from '../../services/engine-connector/seatLive.js';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js';
import type { Message } from '../../types/message.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import type { Screen } from './screen.js';

export function ChatKeys({
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
  children,
}: {
  legacyTranscript: boolean;
  fullscreen: boolean;
  compactWork: CompactWorkControls;
  screen: Screen;
  setScreen: (screen: Screen) => void;
  showAllInTranscript: boolean;
  setShowAllInTranscript: (showAll: boolean) => void;
  messages: Message[];
  handleEnterTranscript: () => void;
  handleExitTranscript: () => void;
  inVirtualTranscriptMode: boolean;
  inVirtualTranscript: boolean;
  searchBarOpen: boolean;
  helpOpen: boolean;
  isSearchingHistory: boolean;
  messageCursorActive: boolean;
  messageActions: { handlers: Record<string, () => void> };
  messageActionsDisabled: boolean;
  focusedInputDialog: FocusedInputDialog | undefined;
  toolUseConfirmQueue: ToolUseConfirm[];
  showMessageSelector: boolean;
  showBashesDialog: string | boolean;
  vimMode: VimMode;
  dialogOwnsKeys: boolean;
  centredModalUp: boolean;
  permissionOverlay: React.ReactNode;
  viewStreamMode: SpinnerMode;
  seatLive: SessionLiveV1;
  onSubmit: React.ComponentProps<typeof CommandKeybindingHandlers>['onSubmit'];
  commands: React.ComponentProps<typeof CommandKeybindingHandlers>['commands'];
  scrollRef: React.RefObject<ScrollBoxHandle | null>;
  modalScrollRef: React.RefObject<ScrollBoxHandle | null>;
  onScroll: (sticky: boolean, handle: ScrollBoxHandle) => void;
  onTranscriptScroll: (sticky: boolean, handle: ScrollBoxHandle) => void;
  children: React.ReactNode;
}): React.ReactNode {
  const [remountKey, setRemountKey] = useState(0);
  const globalKeybindingProps = {
    compactWork,
    screen,
    setScreen,
    showAllInTranscript,
    setShowAllInTranscript,
    messageCount: messages.length,
    onEnterTranscript: handleEnterTranscript,
    onExitTranscript: handleExitTranscript,
    virtualScrollActive: inVirtualTranscriptMode,
    searchBarOpen,
  };
  useHoldsEscape(helpOpen || isSearchingHistory || messageCursorActive);
  const { internal_eventEmitter } = useStdin();
  useClaim(() => {
    const onSuspend = (): void => {
      if (!fullscreen) {
        process.stdout.write('\nMercury suspended — `fg` brings it back (ctrl+z suspends, ctrl+_ undoes input)\n');
      }
    };
    const onResume = (): void => setRemountKey(k => k + 1);
    internal_eventEmitter.on('suspend', onSuspend);
    internal_eventEmitter.on('resume', onResume);
    return () => {
      internal_eventEmitter.removeListener('suspend', onSuspend);
      internal_eventEmitter.removeListener('resume', onResume);
    };
  }, [fullscreen, internal_eventEmitter]);
  const cancelRequestProps = {
    compactWork,
    isInterviewFocused:
      focusedInputDialog === 'tool-permission' && toolUseConfirmQueue[0]?.tool.name === ASK_USER_QUESTION_TOOL_NAME,
    isMessageSelectorVisible: showMessageSelector || showBashesDialog !== false,
    screen,
    vimMode: isVimModeEnabled() ? vimMode : undefined,
    isLocalJSXCommand: dialogOwnsKeys,
    isSearchingHistory,
    isHelpOpen: helpOpen,
    isInputDialogFocused: focusedInputDialog !== undefined,
    streamMode: viewStreamMode,
    focusedTurnActive: seatLive.inFlight,
  };
  const cancelHandler = <CancelRequestHandler {...cancelRequestProps} />;
  if (legacyTranscript) {
    return (
      <>
        <GlobalKeybindingHandlers {...globalKeybindingProps} />
        <CommandKeybindingHandlers onSubmit={onSubmit} commands={commands} isActive={!dialogOwnsKeys} />
        {cancelHandler}
        {children}
      </>
    );
  }
  return (
    <>
      <GlobalKeybindingHandlers {...globalKeybindingProps} />
      <CommandKeybindingHandlers onSubmit={onSubmit} commands={commands} isActive={!dialogOwnsKeys} />
      <ScrollKeybindingHandler
        scrollRef={scrollRef}
        isActive={inVirtualTranscript || (fullscreen && (centredModalUp || focusedInputDialog === undefined || focusedInputDialog === 'tool-permission'))}
        onScroll={inVirtualTranscript ? onTranscriptScroll : (centredModalUp && dialogOwnsKeys) || permissionOverlay !== null ? undefined : onScroll}
        isModal={inVirtualTranscript ? !searchBarOpen : false}
        modalScrollRef={modalScrollRef}
        modalUp={centredModalUp && dialogOwnsKeys}
      />
      {fullscreen && messageCursorActive ? (
        <MessageActionsKeybindings handlers={messageActions.handlers} isActive={!messageActionsDisabled && focusedInputDialog === undefined} />
      ) : null}
      {cancelHandler}
      <SwitchboardAttributionProvider key={remountKey}>{children}</SwitchboardAttributionProvider>
    </>
  );
}
