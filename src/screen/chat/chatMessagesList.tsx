import React from 'react';
import { Messages } from '../messages/Messages.js';
import type { ToolUseConfirm } from '../../permissions/cards/PermissionRequest.js';
import type { useFocusedTailAnchor } from '../focused-session/useFocusedTranscript.js';
import { Box, Text } from '../themedRenderer.js';
import type { Message } from '../../engine/message-shapes/message.js';
import type { StreamingToolUse } from '../messages-list/streamToScreen.js';
import type { useChatAsks } from './useChatAsks.js';
import type { useChatDialogs, useChatDialogsView } from './useChatDialogs.js';
import type { useChatFocusedSeat } from './useChatFocusedSeat.js';
import type { useChatScroll, useChatScrollPin } from './useChatScroll.js';
import type { useChatSearch } from './useChatSearch.js';
import type { useChatRewindPicker, useChatSelectorView } from './useChatSelector.js';
import type { useChatConversation, useChatSession } from './useChatSession.js';
import type { useChatStatusStrip } from './useChatStatus.js';
import type { useChatTools } from './useChatTools.js';

const EMPTY_CONFIRM_QUEUE: ToolUseConfirm[] = [];
const NO_STREAMING_TOOL_USES: StreamingToolUse[] = [];

type MessagesListArgs = Pick<ReturnType<typeof useChatSearch>, 'inVirtualTranscript' | 'inTranscript' | 'screen' | 'showAllInTranscript' | 'jumpRef' | 'onSearchMatchesChange' | 'scanElement' | 'setPositions' | 'dumpMode'> &
  Pick<ReturnType<typeof useChatSession>, 'displayedMessages' | 'paintedMessages'> &
  Pick<ReturnType<typeof useChatTools>, 'mergedTools' | 'commands' | 'agentDefinitions' | 'verbose'> &
  Pick<ReturnType<typeof useChatStatusStrip>, 'viewInProgressToolUseIDs'> &
  Pick<ReturnType<typeof useChatConversation>, 'conversationId'> &
  Pick<ReturnType<typeof useChatFocusedSeat>, 'isLoading' | 'focusedTail'> &
  Pick<ReturnType<typeof useChatScrollPin>, 'scrollRef'> &
  Pick<ReturnType<typeof useChatRewindPicker>, 'showMessageSelector'> &
  Pick<ReturnType<typeof useChatDialogs>, 'toolJSX'> &
  Pick<ReturnType<typeof useChatAsks>, 'toolUseConfirmQueue'> &
  Pick<ReturnType<typeof useChatScroll>, 'unseenDivider'> &
  Pick<ReturnType<typeof useChatSelectorView>, 'messageNavRef'> & {
    streamingSuppressed: boolean;
    messages: Message[];
    tailAnchor: ReturnType<typeof useFocusedTailAnchor>;
  };

export function chatMessagesList({ inVirtualTranscript, inTranscript, screen, showAllInTranscript, jumpRef, onSearchMatchesChange, scanElement, setPositions, dumpMode, displayedMessages, paintedMessages, mergedTools, commands, agentDefinitions, verbose, viewInProgressToolUseIDs, conversationId, isLoading, focusedTail, scrollRef, showMessageSelector, toolJSX, toolUseConfirmQueue, unseenDivider, messageNavRef, streamingSuppressed, messages, tailAnchor }: MessagesListArgs): React.ReactNode {
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

  return messagesList;
}

type TranscriptBodyArgs = Pick<ReturnType<typeof useChatSearch>, 'inVirtualTranscript'> &
  Pick<ReturnType<typeof useChatSession>, 'entryLoadingLine'> &
  Pick<ReturnType<typeof useChatDialogsView>, 'inlineToolJsx'> & {
    messagesList: React.ReactNode;
  };

export function chatTranscriptBody({ inVirtualTranscript, entryLoadingLine, inlineToolJsx, messagesList }: TranscriptBodyArgs): React.ReactNode {
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

  return transcriptBody;
}
