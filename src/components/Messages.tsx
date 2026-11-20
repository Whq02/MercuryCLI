import React, { memo, useCallback, useMemo, useState } from 'react'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { RenderableMessage } from '../types/message.js'
import { isFullscreenActive, isFullscreenEnvEnabled } from '../utils/fullscreen.js'
import { resolveTerminalExperience } from '../ink/session/terminalExperience.js'
import { getGlobalConfig } from '../utils/config.js'
import { getIsRemoteMode } from '../bootstrap/state.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import { useTabRing } from '../ink/terminalWrite.js'
import { type MessageActionsState, InVirtualListContext } from './messageActions.js'
import { setMessageCursor, useMessageCursor } from './messageCursorStore.js'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js'
import { LiveStreamingTail } from './LiveStreamingTail.js'
import { FoldStatusRow } from './FoldStatusRow.js'
import { VirtualMessageList } from './VirtualMessageList.js'
import { CockpitActiveContext } from '../context/cockpitActiveContext.js'
import { useLayoutChrome } from '../context/layoutChromeContext.js'
import { fluxMark } from '../utils/flux/fluxProbe.js'
import { useTranscriptRows } from './messagesList/useTranscriptRows.js'
import { useVisibleRows } from './messagesList/useVisibleRows.js'
import { useRowExpansion } from './messagesList/useRowExpansion.js'
import { useSearchFacets } from './messagesList/useSearchFacets.js'
import { messagesHeader } from './messagesList/header.js'
import { renderMessageRow } from './messagesList/row.js'
import type { MessagesProps } from './messagesList/shapes.js'
export { computeSliceStart, reuseSettledRows, isAssistantContinuationRow, composeTranscript } from './messagesList/transcript.js'

function MessagesInner({
  messages,
  tools,
  verbose,
  toolJSX,
  toolUseConfirmQueue,
  inProgressToolUseIDs,
  isMessageSelectorVisible,
  conversationId,
  screen,
  streamingToolUses,
  showAllInTranscript = false,
  agentDefinitions,
  suppressLogo = false,
  suppressNotices = false,
  isLoading,
  streamingThinking = null,
  hidePastReasoning = false,
  streamingTail = null,
  streamingTextSuppressed = false,
  tailAnchor,
  unseenDivider,
  scrollRef,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
  disableRenderCap = false,
  ownsCursor = false,
  cursorNavRef,
  renderRange,
}: MessagesProps): React.ReactNode {
  const liveCursor = useMessageCursor()
  const cursor: MessageActionsState | null = ownsCursor ? liveCursor : null
  const setCursor = ownsCursor ? setMessageCursor : undefined
  fluxMark('render:messages')
  const { columns } = useTerminalSize()
  const isTranscriptMode = screen === 'transcript'
  const fullscreen = isFullscreenEnvEnabled()
  const inCockpit = React.useContext(CockpitActiveContext)
  const { isCompact } = useLayoutChrome()

  const [virtualEffective] = useState(
    () => resolveTerminalExperience().virtualScroll.effective,
  )
  const virtualised = Boolean(scrollRef) && virtualEffective && isFullscreenActive()

  const { lookups, truncated, hiddenCount, collapsed, afterRows } = useTranscriptRows({ fullscreen, inProgressToolUseIDs, isTranscriptMode, messages, showAllInTranscript, streamingToolUses, tailAnchor, tools, verbose, virtualised })
  const { withheldDisclosure, visible, liveReceipt, lastThinkingBlockId, liveReasoningVisible, latestBashOutputUUID, hasRealConversation } = useVisibleRows({ afterRows, collapsed, conversationId, disableRenderCap, hidePastReasoning, isLoading, renderRange, streamingThinking, virtualised })

  const { expandedKeys, expansionKeyOf, isItemExpanded, lookupsRef, isItemClickable, canAnimate, onItemClick } = useRowExpansion({ conversationId, isMessageSelectorVisible, lookups, toolJSX, toolUseConfirmQueue, tools, verbose, withheldDisclosure })

  const { extractSearchText, extractFacets } = useSearchFacets({ lookups, lookupsRef, tools })

  const ringEnabled = getGlobalConfig().terminalProgressBarEnabled !== false && !getIsRemoteMode()
  useTabRing(isLoading && ringEnabled)

  const header = useMemo(() => {
    return messagesHeader({ agentDefinitions, columns, hasRealConversation, inCockpit, isCompact, renderRange, suppressLogo, suppressNotices })
  }, [agentDefinitions, hasRealConversation, inCockpit, isCompact, columns, suppressLogo, suppressNotices, renderRange])

  const transcriptChord = useShortcutDisplay(
    'transcript:toggleShowAll',
    'Transcript',
    'ctrl+e',
  )

  const itemKey = useCallback(
    (message: RenderableMessage) => `${message.uuid}:${conversationId}`,
    [conversationId],
  )

  const renderRowIn = useCallback(
    (rows: RenderableMessage[], msg_8: RenderableMessage, index: number): React.ReactNode => {
      return renderMessageRow({ rows, msg_8, index, canAnimate, columns, conversationId, cursor, expandedKeys, expansionKeyOf, inProgressToolUseIDs, isItemExpanded, isLoading, isTranscriptMode, lastThinkingBlockId, latestBashOutputUUID, lookups, screen, streamingTail, streamingTextSuppressed, tools, verbose, withheldDisclosure })
    },
    [
      tools,
      verbose,
      inProgressToolUseIDs,
      screen,
      canAnimate,
      lastThinkingBlockId,
      latestBashOutputUUID,
      columns,
      isLoading,
      lookups,
      conversationId,
      cursor,
      expandedKeys,
      expansionKeyOf,
      isItemExpanded,
      withheldDisclosure,
      isTranscriptMode,
      streamingTail,
      streamingTextSuppressed,
    ],
  )
  const renderRow = useCallback(
    (msg: RenderableMessage, index: number): React.ReactNode => renderRowIn(visible, msg, index),
    [renderRowIn, visible],
  )

  const dividerBeforeIndex = useMemo(() => {
    if (!unseenDivider) return -1
    const prefix = unseenDivider.firstUnseenUuid.slice(0, 24)
    return visible.findIndex(message => message.uuid.startsWith(prefix))
  }, [unseenDivider, visible])

  const tail = (
    <>
      {streamingTail ? (
        <LiveStreamingTail
          store={streamingTail}
          textSuppressed={streamingTextSuppressed}
        />
      ) : null}
      {liveReasoningVisible && streamingThinking ? (
        <AssistantThinkingMessage
          param={{ type: 'thinking', thinking: streamingThinking.thinking }}
          addMargin
          verbose={verbose}
        />
      ) : null}
      {}
      <FoldStatusRow rows={visible} conversationId={conversationId} />
      {liveReceipt !== null ? renderRow(liveReceipt, visible.length) : null}
      {afterRows.map((message, index) => (
        <React.Fragment key={itemKey(message)}>{renderRowIn(afterRows, message, index)}</React.Fragment>
      ))}
    </>
  )

  if (virtualised && scrollRef) {
    return (
      <InVirtualListContext.Provider value={true}>
        <Box flexDirection="column" width="100%">
          {header}
          <VirtualMessageList
            messages={visible}
            scrollRef={scrollRef}
            columns={columns}
            itemKey={itemKey}
            renderItem={renderRow}
            onItemClick={onItemClick}
            isItemClickable={isItemClickable}
            isItemExpanded={(message: RenderableMessage) =>
              expandedKeys.has(expansionKeyOf(message))
            }
            extractSearchText={extractSearchText}
            extractFacets={extractFacets}
            selectedIndex={
              cursor
                ? visible.findIndex(message => message.uuid === cursor.uuid)
                : undefined
            }
            selectedExpanded={Boolean((cursor as { expanded?: boolean } | null)?.expanded)}
            cursorNavRef={cursorNavRef}
            setCursor={setCursor}
            jumpRef={jumpRef}
            onSearchMatchesChange={onSearchMatchesChange}
            scanElement={scanElement}
            setPositions={setPositions}
          />
          {tail}
        </Box>
      </InVirtualListContext.Provider>
    )
  }

  return (
    <Box flexDirection="column" width="100%">
      {header}
      {truncated && hiddenCount > 0 ? (
        <Text dimColor>
          {hiddenCount} previous {hiddenCount === 1 ? 'message' : 'messages'}{' '}
          hidden — {transcriptChord} shows all
        </Text>
      ) : null}
      {isTranscriptMode && showAllInTranscript && !disableRenderCap ? (
        <Text dimColor>showing all — {transcriptChord} hides older rows</Text>
      ) : null}
      {visible.map((message, index) => (
        <React.Fragment key={itemKey(message)}>
          {index === dividerBeforeIndex && unseenDivider ? (
            <Text key={`divider-${unseenDivider.firstUnseenUuid}`} dimColor>
              {'─'.repeat(Math.max(4, Math.floor(columns / 3)))} {unseenDivider.count} new{' '}
              {'─'.repeat(Math.max(4, Math.floor(columns / 3)))}
            </Text>
          ) : null}
          {renderRow(message, index)}
        </React.Fragment>
      ))}
      {tail}
    </Box>
  )
}

function areMessagesPropsEqual(
  prev: MessagesProps,
  next: MessagesProps,
): boolean {
  if (prev.streamingThinking !== next.streamingThinking) return false
  if (prev.messages !== next.messages) return false
  if (prev.verbose !== next.verbose) return false
  if (prev.screen !== next.screen) return false
  if (prev.isLoading !== next.isLoading) return false
  if (prev.showAllInTranscript !== next.showAllInTranscript) return false
  if (prev.toolJSX !== next.toolJSX) return false
  if (prev.isMessageSelectorVisible !== next.isMessageSelectorVisible) {
    return false
  }
  if (prev.conversationId !== next.conversationId) return false
  if (prev.disableRenderCap !== next.disableRenderCap) return false
  if (prev.hidePastReasoning !== next.hidePastReasoning) return false
  if (prev.suppressLogo !== next.suppressLogo) return false
  if (prev.suppressNotices !== next.suppressNotices) return false
  if (prev.ownsCursor !== next.ownsCursor) return false
  if (prev.renderRange !== next.renderRange) return false
  if (prev.streamingTail !== next.streamingTail) return false
  if (prev.streamingTextSuppressed !== next.streamingTextSuppressed) return false
  if (prev.tailAnchor !== next.tailAnchor) return false
  if (prev.toolUseConfirmQueue.length !== next.toolUseConfirmQueue.length) {
    return false
  }
  if (prev.agentDefinitions !== next.agentDefinitions) return false
  if (prev.streamingToolUses.length !== next.streamingToolUses.length) {
    return false
  }
  for (let i = 0; i < prev.streamingToolUses.length; i++) {
    if (
      prev.streamingToolUses[i]!.contentBlock !==
      next.streamingToolUses[i]!.contentBlock
    ) {
      return false
    }
  }
  if (prev.inProgressToolUseIDs.size !== next.inProgressToolUseIDs.size) {
    return false
  }
  for (const id of prev.inProgressToolUseIDs) {
    if (!next.inProgressToolUseIDs.has(id)) return false
  }
  if (
    prev.unseenDivider?.firstUnseenUuid !== next.unseenDivider?.firstUnseenUuid ||
    prev.unseenDivider?.count !== next.unseenDivider?.count
  ) {
    return false
  }
  if (prev.tools.length !== next.tools.length) return false
  for (let i = 0; i < prev.tools.length; i++) {
    if (prev.tools[i]!.name !== next.tools[i]!.name) return false
  }
  return true
}

export const Messages = memo(MessagesInner, areMessagesPropsEqual)

export default Messages
