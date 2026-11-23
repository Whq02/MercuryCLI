import React, { useState } from 'react';
import { MessageActionsKeybindings } from '../messages/messageActions.js';
import type { ToolUseConfirm } from '../../permissions/cards/PermissionRequest.js';
import { isVimModeEnabled } from '../composer/composerConfig.js';
import { ScrollKeybindingHandler } from '../scroll-keys/ScrollKeybindingHandler.js';
import type { SpinnerMode } from '../spinner/spinnerMode.js';
import { SwitchboardAttributionProvider } from './SwitchboardTagBar.js';
import type { CompactWorkControls } from '../tasks/CompactWorkSummary.js';
import { CancelRequestHandler } from './interruptKeys.js';
import { CommandKeybindingHandlers } from './useCommandKeybindings.js';
import { useHoldsEscape } from '../keys/useEscapeOwned.js';
import { GlobalKeybindingHandlers } from './useGlobalKeybindings.js';
import { useClaim } from '../effects/effects.js';
import type { VimMode } from '../composer/vim/useVimInput.js';
import { useStdin } from '../themedRenderer.js';
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js';
import type { SessionLiveV1 } from '../../engine/connector/seatLive.js';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/ask-question/prompt.js';
import type { Message } from '../../engine/message-shapes/message.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import type { Screen } from './screen.js';

const SUSPEND_NOTICE = '\nMercury suspended — `fg` brings it back (ctrl+z suspends, ctrl+_ undoes input)\n';

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
  useHoldsEscape(helpOpen || isSearchingHistory || messageCursorActive);

  const { internal_eventEmitter } = useStdin();
  const [remountKey, setRemountKey] = useState(0);
  useClaim(() => {
    const onSuspend = (): void => {
      if (!fullscreen) {
        process.stdout.write(SUSPEND_NOTICE);
      }
    };
    const onResume = (): void => {
      setRemountKey(n => n + 1);
    };
    internal_eventEmitter.on('suspend', onSuspend);
    internal_eventEmitter.on('resume', onResume);
    return () => {
      internal_eventEmitter.off('suspend', onSuspend);
      internal_eventEmitter.off('resume', onResume);
    };
  }, [internal_eventEmitter, fullscreen]);

  const globalHandler = (
    <GlobalKeybindingHandlers
      screen={screen}
      setScreen={setScreen}
      showAllInTranscript={showAllInTranscript}
      setShowAllInTranscript={setShowAllInTranscript}
      messageCount={messages.length}
      onEnterTranscript={handleEnterTranscript}
      onExitTranscript={handleExitTranscript}
      virtualScrollActive={inVirtualTranscriptMode}
      searchBarOpen={searchBarOpen}
      compactWork={compactWork}
    />
  );

  const commandHandler = (
    <CommandKeybindingHandlers
      onSubmit={onSubmit}
      commands={commands}
      isActive={!dialogOwnsKeys}
    />
  );

  const cancelHandler = (
    <CancelRequestHandler
      focusedTurnActive={seatLive.inFlight}
      compactWork={compactWork}
      isInterviewFocused={
        focusedInputDialog === 'tool-permission' &&
        toolUseConfirmQueue[0]?.tool.name === ASK_USER_QUESTION_TOOL_NAME
      }
      isMessageSelectorVisible={showMessageSelector || showBashesDialog !== false}
      screen={screen}
      vimMode={isVimModeEnabled() ? vimMode : undefined}
      isLocalJSXCommand={dialogOwnsKeys}
      isSearchingHistory={isSearchingHistory}
      isHelpOpen={helpOpen}
      isInputDialogFocused={focusedInputDialog !== undefined}
      streamMode={viewStreamMode}
    />
  );

  if (legacyTranscript) {
    return (
      <>
        {globalHandler}
        {commandHandler}
        {cancelHandler}
        {children}
      </>
    );
  }

  const modalUp = centredModalUp && dialogOwnsKeys;
  const scrollActive =
    inVirtualTranscript ||
    (fullscreen &&
      (centredModalUp ||
        focusedInputDialog === undefined ||
        focusedInputDialog === 'tool-permission'));
  const scrollCallback = inVirtualTranscript
    ? onTranscriptScroll
    : modalUp || permissionOverlay != null
      ? undefined
      : onScroll;

  return (
    <>
      {globalHandler}
      {commandHandler}
      <ScrollKeybindingHandler
        scrollRef={scrollRef}
        isActive={scrollActive}
        onScroll={scrollCallback}
        isModal={inVirtualTranscript ? !searchBarOpen : false}
        modalScrollRef={modalScrollRef}
        modalUp={modalUp}
      />
      {fullscreen && messageCursorActive ? (
        <MessageActionsKeybindings
          handlers={messageActions.handlers}
          isActive={!messageActionsDisabled && focusedInputDialog === undefined}
        />
      ) : null}
      {cancelHandler}
      <SwitchboardAttributionProvider key={remountKey}>
        {children}
      </SwitchboardAttributionProvider>
    </>
  );
}
