import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { EMPTY_STRING_SET } from '../../engine/messages/lookups.js'
import { RowErrorBoundary } from '../messages/RowErrorBoundary.js'
import type { MessageActionsState } from '../messages/messageActions.js'
import { NameplateContinuationContext } from '../messages/TranscriptNameplate.js'
import { AssistantThinkingMessage } from '../messages/AssistantThinkingMessage.js'
import { hasContentAfterIndex, MessageRow } from '../messages/MessageRow.js'
import { isAssistantContinuationRow } from './transcript.js'
import type { MessagesProps, RowExpansionState, VisibleRowsState, TranscriptRowsState } from './shapes.js'

export function renderMessageRow({ rows, msg_8, index, canAnimate, columns, conversationId, cursor, expandedKeys, expansionKeyOf, inProgressToolUseIDs, isItemExpanded, isLoading, isTranscriptMode, lastThinkingBlockId, latestBashOutputUUID, lookups, screen, streamingTail, streamingTextSuppressed, tools, verbose, withheldDisclosure }: { rows: RenderableMessage[]; msg_8: RenderableMessage; index: number; canAnimate: RowExpansionState['canAnimate']; columns: number; conversationId: MessagesProps['conversationId']; cursor: MessageActionsState | null; expandedKeys: RowExpansionState['expandedKeys']; expansionKeyOf: RowExpansionState['expansionKeyOf']; inProgressToolUseIDs: MessagesProps['inProgressToolUseIDs']; isItemExpanded: RowExpansionState['isItemExpanded']; isLoading: MessagesProps['isLoading']; isTranscriptMode: boolean; lastThinkingBlockId: VisibleRowsState['lastThinkingBlockId']; latestBashOutputUUID: VisibleRowsState['latestBashOutputUUID']; lookups: TranscriptRowsState['lookups']; screen: MessagesProps['screen']; streamingTail: Exclude<MessagesProps['streamingTail'], undefined>; streamingTextSuppressed: Exclude<MessagesProps['streamingTextSuppressed'], undefined>; tools: MessagesProps['tools']; verbose: MessagesProps['verbose']; withheldDisclosure: VisibleRowsState['withheldDisclosure'] }) {
  const key = expansionKeyOf(msg_8)
  const withheld = withheldDisclosure.byRow.get(msg_8.uuid)
  const hidden = withheldDisclosure.hidden.has(msg_8.uuid)
  if (hidden && !withheld) return null
  return (
    <NameplateContinuationContext.Provider
      value={isAssistantContinuationRow(rows, index)}
    >
      {}
      <RowErrorBoundary>
      {withheld && (
        <AssistantThinkingMessage
          param={withheld}
          addMargin
          verbose={verbose || isItemExpanded(msg_8)}
          isTranscriptMode={isTranscriptMode}
        />
      )}
      {!hidden && <MessageRow
        message={msg_8}
        isUserContinuation={
          msg_8.type === 'user' && rows[index - 1]?.type === 'user'
        }
        hasContentAfter={
          msg_8.type === 'collapsed_read_search' &&
          (streamingTail !== null && !streamingTextSuppressed && isLoading
            ? true
            : hasContentAfterIndex(
                rows,
                index,
                tools,
                EMPTY_STRING_SET as Set<string>,
              ))
        }
        tools={tools}
        verbose={verbose || isItemExpanded(msg_8)}
        inProgressToolUseIDs={inProgressToolUseIDs}
        streamingToolUseIDs={EMPTY_STRING_SET as Set<string>}
        screen={screen}
        canAnimate={canAnimate}
        lastThinkingBlockId={lastThinkingBlockId}
        latestBashOutputUUID={latestBashOutputUUID}
        columns={columns}
        isLoading={isLoading}
        lookups={lookups}
        conversationId={conversationId}
        isCursorRow={cursor?.uuid === msg_8.uuid}
        cursorExpanded={Boolean(
          cursor?.uuid === msg_8.uuid &&
            (cursor as { expanded?: boolean } | null)?.expanded,
        )}
        clickExpanded={expandedKeys.has(key)}
      />}
      </RowErrorBoundary>
    </NameplateContinuationContext.Provider>
  )
}
