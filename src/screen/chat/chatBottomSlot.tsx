import React from 'react';
import type { useCompactWorkControls } from '../tasks/CompactWorkSummary.js';
import Composer from '../composer/Composer.js';
import { MessageActionsBar } from '../messages/messageActions.js';
import { Box } from '../themedRenderer.js';
import { getShortcutDisplay } from '../keys/shortcutFormat.js';
import type { FocusedInputDialog } from './focusedDialog.js';
import type { useChatAsks } from './useChatAsks.js';
import type { useChatDialogPaints, useChatDialogs } from './useChatDialogs.js';
import type { useChatDraft } from './useChatDraft.js';
import { TranscriptFooter, TranscriptSearchBar, type useChatSearch } from './useChatSearch.js';
import type { useChatRewindPicker, useChatRewindPickerView } from './useChatSelector.js';
import type { useChatSubmit, useChatSubmitTools } from './useChatSubmit.js';
import type { useChatTools } from './useChatTools.js';

const NO_MCP_CLIENTS: never[] = [];

type BottomSlotArgs = Pick<ReturnType<typeof useChatDialogs>, 'isExiting' | 'showExitFlow' | 'toolJSX' | 'showBashesDialog' | 'setShowBashesDialog' | 'handleExit'> &
  Pick<ReturnType<typeof useChatTools>, 'toolPermissionContext' | 'apiKeyVerification' | 'commands' | 'agentDefinitions' | 'verbose'> &
  Pick<ReturnType<typeof useChatAsks>, 'setToolPermissionContext'> &
  Pick<ReturnType<typeof useChatSubmitTools>, 'submitCount' | 'getToolUseContext'> &
  Pick<ReturnType<typeof useChatRewindPicker>, 'openMessageSelector'> &
  Pick<ReturnType<typeof useChatRewindPickerView>, 'messageActionsDisabled' | 'messageActions' | 'messageCursorActive'> &
  Pick<ReturnType<typeof useChatDraft>, 'vimMode' | 'setVimMode' | 'isSearchingHistory' | 'setIsSearchingHistory' | 'helpOpen' | 'setHelpOpen' | 'insertTextRef'> &
  Pick<ReturnType<typeof useChatSubmit>, 'onSubmit'> &
  Pick<ReturnType<typeof useChatDialogPaints>, 'dialogPaints'> &
  Pick<ReturnType<typeof useChatSearch>, 'inTranscript' | 'searchBarOpen' | 'previewSearch' | 'commitSearch' | 'cancelSearch' | 'warmSearchIndex' | 'searchMatchCount' | 'searchMatchCurrent' | 'committedSearchQuery' | 'inVirtualTranscript' | 'dumpMode' | 'showAllInTranscript' | 'editorStatus'> & {
    disabled: boolean;
    debug: boolean;
    disableSlashCommands: boolean;
    focusedInputDialog: FocusedInputDialog | undefined;
    compactWork: ReturnType<typeof useCompactWorkControls>['controls'];
    compactFocus: ReturnType<typeof useCompactWorkControls>['focus'];
    isLoading: boolean;
    dialogsHiddenWhileTyping: boolean;
    columns: number;
  };

export function chatBottomSlot({ isExiting, showExitFlow, toolJSX, showBashesDialog, setShowBashesDialog, handleExit, toolPermissionContext, apiKeyVerification, commands, agentDefinitions, verbose, setToolPermissionContext, submitCount, getToolUseContext, openMessageSelector, messageActionsDisabled, messageActions, messageCursorActive, vimMode, setVimMode, isSearchingHistory, setIsSearchingHistory, helpOpen, setHelpOpen, insertTextRef, onSubmit, dialogPaints, inTranscript, searchBarOpen, previewSearch, commitSearch, cancelSearch, warmSearchIndex, searchMatchCount, searchMatchCurrent, committedSearchQuery, inVirtualTranscript, dumpMode, showAllInTranscript, editorStatus, disabled, debug, disableSlashCommands, focusedInputDialog, compactWork, compactFocus, isLoading, dialogsHiddenWhileTyping, columns }: BottomSlotArgs): React.ReactNode {
  const composer = !disabled && !isExiting && !showExitFlow && !toolJSX?.shouldHidePromptInput && (focusedInputDialog === undefined || compactFocus === 'detail') ? (
    <Composer
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

  const composerGroup = composer ? <Box flexDirection="column" display={focusedInputDialog === undefined ? "flex" : "none"}>{composer}</Box> : null;
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

  return bottomSlot;
}
