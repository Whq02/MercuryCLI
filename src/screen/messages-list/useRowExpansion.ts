import { useCallback, useRef, useSyncExternalStore } from 'react'
import type { NormalizedMessage, RenderableMessage } from '../../engine/message-shapes/message.js'
import { AGENT_TOOL_NAME } from '../../tools/kit/names/agent.js'
import { hiddenAgentToolUses } from '../../tools/crewmate/rows.js'
import { expandedRowsOf, subscribeExpandedRows, toggleExpandedRow } from '../messages/transcriptMemory.js'
import { getToolUseID } from '../../engine/messages/lookups.js'
import { hasNoticeFold } from '../../engine/message-shapes/noticeRows.js'
import { findToolByName } from '../../tools/kit/tool.js'
import type { MessagesProps, VisibleRowsState, TranscriptRowsState } from './shapes.js'

export function useRowExpansion({ conversationId, isMessageSelectorVisible, lookups, toolJSX, toolUseConfirmQueue, tools, verbose, withheldDisclosure }: { conversationId: MessagesProps['conversationId']; isMessageSelectorVisible: MessagesProps['isMessageSelectorVisible']; lookups: TranscriptRowsState['lookups']; toolJSX: MessagesProps['toolJSX']; toolUseConfirmQueue: MessagesProps['toolUseConfirmQueue']; tools: MessagesProps['tools']; verbose: MessagesProps['verbose']; withheldDisclosure: VisibleRowsState['withheldDisclosure'] }) {
  const subscribeExpansion = useCallback(
    (listener: () => void) => subscribeExpandedRows(conversationId, listener),
    [conversationId],
  )
  const readExpansion = useCallback(() => expandedRowsOf(conversationId), [conversationId])
  const expandedKeys = useSyncExternalStore(subscribeExpansion, readExpansion, readExpansion)
  const expansionKeyOf = useCallback((msg: RenderableMessage): string => {
    if (
      msg.type !== 'grouped_tool_use' &&
      msg.type !== 'collapsed_read_search' &&
      msg.type !== 'turn_receipt'
    ) {
      return getToolUseID(msg as NormalizedMessage) ?? msg.uuid
    }
    return msg.uuid
  }, [])

  const isItemExpanded = useCallback(
    (msg: RenderableMessage): boolean => expandedKeys.has(expansionKeyOf(msg)),
    [expandedKeys, expansionKeyOf],
  )

  const lookupsRef = useRef(lookups)
  lookupsRef.current = lookups
  const errorFoldCache = useRef(new WeakMap<object, boolean>())

  const isAgentToolName = useCallback(
    (name?: string): boolean =>
      name === AGENT_TOOL_NAME,
    [],
  )
  const agentFoldHidden = useCallback(
    (toolUseID: string): boolean => {
      const progress =
        lookupsRef.current.progressMessagesByToolUseID.get(toolUseID) ?? []
      return hiddenAgentToolUses(progress, tools) > 0
    },
    [tools],
  )

  const isItemClickable = useCallback(
    (message: RenderableMessage): boolean => {
      if (!verbose && withheldDisclosure.byRow.has(message.uuid)) return true
      if (!verbose && hasNoticeFold(message)) return true
      if (message.type === 'collapsed_read_search') return true
      const live = lookupsRef.current
      if (message.type === 'assistant') {
        const content = Array.isArray(message.message.content)
          ? message.message.content
          : []
        const first = content[0]
        if (first?.type === 'thinking') {
          return (
            !verbose && typeof first.thinking === 'string' &&
            first.thinking.trim().length > 0
          )
        }
        if (
          !verbose &&
          first?.type === 'tool_use' && isAgentToolName(first.name) &&
          agentFoldHidden((first as { id: string }).id)
        ) {
          return true
        }
        return false
      }
      if (message.type === 'user') {
        const content = message.message.content
        if (!Array.isArray(content)) return false
        const result = content.find(block => block.type === 'tool_result')
        if (!result) return false
        const b_0 = result as { tool_use_id: string }
        if (
          !verbose &&
          isAgentToolName(lookupsRef.current.toolUseByToolUseID.get(b_0.tool_use_id)?.name) &&
          agentFoldHidden(b_0.tool_use_id)
        ) {
          return true
        }
        const cached = errorFoldCache.current.get(message)
        if (cached !== undefined) return cached
        const id = (result as { tool_use_id?: string }).tool_use_id
        const toolUse = id ? live.toolUseByToolUseID.get(id) : undefined
        const tool = toolUse ? findToolByName(tools, toolUse.name) : undefined
        const record = (message as { toolUseResult?: unknown }).toolUseResult
        let verdict = false
        if ((result as { is_error?: boolean }).is_error) {
          verdict = true
        } else if (record !== undefined && tool) {
          verdict =
            (
              tool as {
                isResultTruncated?: (result: unknown) => boolean
              }
            ).isResultTruncated?.(record) === true
        }
        errorFoldCache.current.set(message, verdict)
        return verdict
      }
      return false
  }, [tools, verbose, isAgentToolName, agentFoldHidden, withheldDisclosure]);

  const canAnimate =
    !(
      toolJSX !== null &&
      !(toolJSX as { continueAnimation?: boolean }).continueAnimation
    ) &&
    toolUseConfirmQueue.length === 0 &&
    !isMessageSelectorVisible

  const onItemClick = useCallback(
    (message: RenderableMessage) => toggleExpandedRow(conversationId, expansionKeyOf(message)),
    [conversationId, expansionKeyOf],
  )
  return { expandedKeys, expansionKeyOf, isItemExpanded, lookupsRef, isItemClickable, canAnimate, onItemClick }
}
