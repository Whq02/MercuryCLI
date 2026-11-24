import React, { memo, useCallback, useMemo, useState } from 'react'
import { Box, Text } from '../themedRenderer.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { isFullscreenActive, isFullscreenEnvEnabled } from '../fullscreen-layout/fullscreen.js'
import { resolveTerminalExperience } from '../renderer/terminal-session/terminalExperience.js'
import { getGlobalConfig } from '../../platform/settings/config.js'
import { getIsRemoteMode } from '../../boot/process-state/processState.js'
import { useShortcutDisplay } from '../keys/useShortcutDisplay.js'
import { useTabRing } from '../renderer/terminalWrite.js'
import { type MessageActionsState, InVirtualListContext } from './messageActions.js'
import { setMessageCursor, useMessageCursor } from './messageCursorStore.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'
import { LiveStreamingTail } from './LiveStreamingTail.js'
import { FoldStatusRow } from './FoldStatusRow.js'
import { VirtualMessageList } from '../virtual-message-list/VirtualMessageList.js'
import { CockpitActiveContext } from '../cockpit/cockpitActiveContext.js'
import { useLayoutChrome } from '../fullscreen-layout/layoutChromeContext.js'
import { fluxMark } from '../../integrations/media-flux/fluxProbe.js'
import { useTranscriptRows } from '../messages-list/useTranscriptRows.js'
import { useVisibleRows } from '../messages-list/useVisibleRows.js'
import { useRowExpansion } from '../messages-list/useRowExpansion.js'
import { useSearchFacets } from '../messages-list/useSearchFacets.js'
import { messagesHeader } from '../messages-list/header.js'
import { renderMessageRow } from '../messages-list/row.js'
import type { MessagesProps } from '../messages-list/shapes.js'
export { computeSliceStart, reuseSettledRows, isAssistantContinuationRow, composeTranscript } from '../messages-list/transcript.js'

function MessagesInner({
  messages,
  tools,
  verbose,
  toolJSX,
  toolUseConfirmQueue,
  inProgressToolUseIDs,
  isRewindPickerVisible,
  conversationId,
  screen,
  streamingToolUses,
  isLoading,
  showAllInTranscript = false,
  agentDefinitions,
  suppressLogo = false,
  suppressNotices = false,
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
  fluxMark('render:messages')

  const { columns } = useTerminalSize()
  const inCockpit = React.useContext(CockpitActiveContext)
  const { isCompact } = useLayoutChrome()
  const isTranscriptMode = screen === 'transcript'
  const [virtualScrollPolicy] = useState(
    () => resolveTerminalExperience().virtualScroll.effective,
  )
  const fullscreen = isFullscreenEnvEnabled()
  const virtualised =
    virtualScrollPolicy && scrollRef !== undefined && isFullscreenActive()

  const liveCursor = useMessageCursor()
  const cursor: MessageActionsState | null = ownsCursor ? liveCursor : null

  useTabRing(
    isLoading &&
      getGlobalConfig().terminalProgressBarEnabled !== false &&
      !getIsRemoteMode(),
  )

  const toggleShowAllChord = useShortcutDisplay(
    'transcript:toggleShowAll',
    'Transcript',
    'ctrl+e',
  )

  const { collapsed, lookups, truncated, hiddenCount, afterRows } =
    useTranscriptRows({
      fullscreen,
      inProgressToolUseIDs,
      isTranscriptMode,
      messages,
      showAllInTranscript,
      streamingToolUses,
      tailAnchor,
      tools,
      verbose,
      virtualised,
    })

  const {
    withheldDisclosure,
    visible,
    liveReceipt,
    lastThinkingBlockId,
    liveReasoningVisible,
    latestBashOutputUUID,
    hasRealConversation,
  } = useVisibleRows({
    afterRows,
    collapsed,
    conversationId,
    disableRenderCap,
    hidePastReasoning,
    isLoading,
    renderRange,
    streamingThinking,
    virtualised,
  })

  const {
    expandedKeys,
    expansionKeyOf,
    isItemExpanded,
    lookupsRef,
    isItemClickable,
    canAnimate,
    onItemClick,
  } = useRowExpansion({
    conversationId,
    isRewindPickerVisible,
    lookups,
    toolJSX,
    toolUseConfirmQueue,
    tools,
    verbose,
    withheldDisclosure,
  })

  const { extractSearchText, extractFacets } = useSearchFacets({
    lookups,
    lookupsRef,
    tools,
  })

  const header = messagesHeader({
    agentDefinitions,
    columns,
    hasRealConversation,
    inCockpit,
    isCompact,
    renderRange,
    suppressLogo,
    suppressNotices,
  })

  const itemKey = useCallback(
    (msg: RenderableMessage) => `${msg.uuid}:${conversationId}`,
    [conversationId],
  )

  const renderRow = useCallback(
    (rows: RenderableMessage[], msg: RenderableMessage, index: number) =>
      renderMessageRow({
        rows,
        msg_8: msg,
        index,
        canAnimate,
        columns,
        conversationId,
        cursor,
        expandedKeys,
        expansionKeyOf,
        inProgressToolUseIDs,
        isItemExpanded,
        isLoading,
        isTranscriptMode,
        lastThinkingBlockId,
        latestBashOutputUUID,
        lookups,
        screen,
        streamingTail,
        streamingTextSuppressed,
        tools,
        verbose,
        withheldDisclosure,
      }),
    [
      canAnimate,
      columns,
      conversationId,
      cursor,
      expandedKeys,
      expansionKeyOf,
      inProgressToolUseIDs,
      isItemExpanded,
      isLoading,
      isTranscriptMode,
      lastThinkingBlockId,
      latestBashOutputUUID,
      lookups,
      screen,
      streamingTail,
      streamingTextSuppressed,
      tools,
      verbose,
      withheldDisclosure,
    ],
  )

  const renderVisibleRow = useCallback(
    (msg: RenderableMessage, index: number) => renderRow(visible, msg, index),
    [renderRow, visible],
  )

  const selectedIndex = useMemo(
    () =>
      cursor !== null
        ? visible.findIndex(row => row.uuid === cursor.uuid)
        : undefined,
    [cursor, visible],
  )

  const tail = (
    <>
      {streamingTail !== null ? (
        <LiveStreamingTail
          store={streamingTail}
          textSuppressed={streamingTextSuppressed}
        />
      ) : null}
      {liveReasoningVisible && streamingThinking !== null ? (
        <AssistantThinkingMessage
          param={{ type: 'thinking', thinking: streamingThinking.thinking }}
          addMargin
          verbose={verbose}
        />
      ) : null}
      <FoldStatusRow rows={collapsed} conversationId={conversationId} />
      {liveReceipt !== null ? (
        <React.Fragment key={itemKey(liveReceipt)}>
          {renderRow(visible, liveReceipt, visible.length)}
        </React.Fragment>
      ) : null}
      {afterRows.map((msg, index) => (
        <React.Fragment key={itemKey(msg)}>
          {renderRow(afterRows, msg, index)}
        </React.Fragment>
      ))}
    </>
  )

  if (virtualised && scrollRef !== undefined) {
    const jumpRefObj =
      jumpRef !== undefined && jumpRef !== null && typeof jumpRef === 'object'
        ? jumpRef
        : undefined
    return (
      <InVirtualListContext.Provider value={true}>
        <Box flexDirection="column" width="100%">
          {header}
          <VirtualMessageList
            messages={visible}
            columns={columns}
            scrollRef={scrollRef}
            itemKey={itemKey}
            renderItem={renderVisibleRow}
            onItemClick={onItemClick}
            isItemClickable={isItemClickable}
            isItemExpanded={isItemExpanded}
            selectedIndex={selectedIndex}
            selectedExpanded={cursor?.expanded}
            cursorNavRef={ownsCursor ? cursorNavRef : undefined}
            setCursor={ownsCursor ? setMessageCursor : undefined}
            extractSearchText={extractSearchText}
            extractFacets={extractFacets}
            jumpRef={jumpRefObj}
            onSearchMatchesChange={onSearchMatchesChange}
            scanElement={scanElement}
            setPositions={setPositions}
          />
          {tail}
        </Box>
      </InVirtualListContext.Provider>
    )
  }

  const dividerIndex =
    unseenDivider !== undefined
      ? visible.findIndex(row =>
          row.uuid.startsWith(unseenDivider.firstUnseenUuid.slice(0, 24)),
        )
      : -1
  const dividerBar = '─'.repeat(Math.max(4, Math.floor(columns / 3)))

  return (
    <Box flexDirection="column" width="100%">
      {header}
      {truncated && hiddenCount > 0 ? (
        <Text dimColor>
          {hiddenCount} previous {hiddenCount === 1 ? 'message' : 'messages'}{' '}
          hidden — {toggleShowAllChord} shows all
        </Text>
      ) : null}
      {isTranscriptMode && showAllInTranscript && !disableRenderCap ? (
        <Text dimColor>
          showing all — {toggleShowAllChord} hides older rows
        </Text>
      ) : null}
      {visible.map((msg, index) => (
        <React.Fragment key={itemKey(msg)}>
          {index === dividerIndex && unseenDivider !== undefined ? (
            <Text dimColor>
              {dividerBar} {unseenDivider.count} new {dividerBar}
            </Text>
          ) : null}
          {renderRow(visible, msg, index)}
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
  if (prev.messages !== next.messages) return false
  if (prev.verbose !== next.verbose) return false
  if (prev.screen !== next.screen) return false
  if (prev.isLoading !== next.isLoading) return false
  if (prev.showAllInTranscript !== next.showAllInTranscript) return false
  if (prev.toolJSX !== next.toolJSX) return false
  if (prev.isRewindPickerVisible !== next.isRewindPickerVisible) {
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
  if (prev.streamingThinking !== next.streamingThinking) return false
  if (prev.streamingTextSuppressed !== next.streamingTextSuppressed) {
    return false
  }
  if (prev.tailAnchor !== next.tailAnchor) return false
  if (prev.agentDefinitions !== next.agentDefinitions) return false

  if (prev.toolUseConfirmQueue.length !== next.toolUseConfirmQueue.length) {
    return false
  }

  if (prev.streamingToolUses.length !== next.streamingToolUses.length) {
    return false
  }
  for (let i = 0; i < prev.streamingToolUses.length; i++) {
    if (
      prev.streamingToolUses[i]?.contentBlock !==
      next.streamingToolUses[i]?.contentBlock
    ) {
      return false
    }
  }

  if (prev.inProgressToolUseIDs !== next.inProgressToolUseIDs) {
    if (prev.inProgressToolUseIDs.size !== next.inProgressToolUseIDs.size) {
      return false
    }
    for (const id of prev.inProgressToolUseIDs) {
      if (!next.inProgressToolUseIDs.has(id)) return false
    }
  }

  if (
    prev.unseenDivider?.firstUnseenUuid !==
      next.unseenDivider?.firstUnseenUuid ||
    prev.unseenDivider?.count !== next.unseenDivider?.count
  ) {
    return false
  }

  if (prev.tools !== next.tools) {
    if (prev.tools.length !== next.tools.length) return false
    for (let i = 0; i < prev.tools.length; i++) {
      if (prev.tools[i]?.name !== next.tools[i]?.name) return false
    }
  }

  return true
}

export const Messages = memo(MessagesInner, areMessagesPropsEqual)

export default Messages
