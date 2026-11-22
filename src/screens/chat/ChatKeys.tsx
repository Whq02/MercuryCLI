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
import { notBuilt } from '../../pi/holes.js'

export function ChatKeys(arg0: {
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
  return notBuilt('src/screens/chat/ChatKeys.tsx:23')
}
