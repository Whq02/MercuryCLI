import { useMemo } from 'react'
import type { RenderableMessage } from '../../engine/message-shapes/message.js'
import { transcriptMemoryOf } from '../messages/transcriptMemory.js'
import { hasActivity } from '../cockpit/turnReceipt.js'
import { hasRealConversation as computeHasRealConversation } from '../cockpit/realConversation.js'
import { withheldThinkingDisclosure } from '../messages/withheldThinkingDisclosure.js'
import { computeSliceStart, LIVE_REASONING_LINGER_MS } from './transcript.js'
import type { MessagesProps, TranscriptRowsState } from './shapes.js'

export function useVisibleRows({ afterRows, collapsed, conversationId, disableRenderCap, hidePastReasoning, isLoading, renderRange, streamingThinking, virtualised }: { afterRows: TranscriptRowsState['afterRows']; collapsed: TranscriptRowsState['collapsed']; conversationId: MessagesProps['conversationId']; disableRenderCap: Exclude<MessagesProps['disableRenderCap'], undefined>; hidePastReasoning: Exclude<MessagesProps['hidePastReasoning'], undefined>; isLoading: MessagesProps['isLoading']; renderRange: MessagesProps['renderRange']; streamingThinking: Exclude<MessagesProps['streamingThinking'], undefined>; virtualised: boolean }) {
  const withheldDisclosure = useMemo(
    () => withheldThinkingDisclosure([...collapsed, ...afterRows]),
    [collapsed, afterRows],
  )

  const anchorRef = transcriptMemoryOf(conversationId).anchor
  const { visible, liveReceipt } = useMemo(() => {
    let rows: RenderableMessage[]
    if (renderRange) {
      rows = collapsed.slice(renderRange[0], renderRange[1])
    } else if (virtualised || disableRenderCap) {
      rows = collapsed
    } else {
      const start = computeSliceStart(collapsed, anchorRef)
      rows = start > 0 ? collapsed.slice(start) : collapsed
    }
    const last = rows[rows.length - 1]
    if (isLoading && !renderRange && last !== undefined && last.type === 'turn_receipt') {
      return { visible: rows.slice(0, -1), liveReceipt: hasActivity(last.counts) ? last : null }
    }
    return { visible: rows, liveReceipt: null }
  }, [collapsed, virtualised, disableRenderCap, renderRange, isLoading])

  const lastThinkingBlockId = useMemo(() => {
    if (!hidePastReasoning) return null
    if (streamingThinking?.isStreaming) return 'streaming-sentinel'
    for (let i = collapsed.length - 1; i >= 0; i--) {
      const message = collapsed[i]!
      if (message.type === 'user') {
        const content = message.message.content
        const isToolResultRow =
          Array.isArray(content) &&
          content.some(block => block.type === 'tool_result')
        if (!isToolResultRow) return 'no-thinking-sentinel'
        continue
      }
      if (message.type !== 'assistant') continue
      const content = Array.isArray(message.message.content)
        ? message.message.content
        : []
      for (let b = content.length - 1; b >= 0; b--) {
        if (content[b]!.type === 'thinking') {
          return `${message.uuid}:${b}`
        }
      }
    }
    return 'no-thinking-sentinel'
  }, [hidePastReasoning, collapsed, streamingThinking?.isStreaming])

  const liveReasoningVisible =
    streamingThinking !== null &&
    (streamingThinking.isStreaming ||
      (streamingThinking.streamingEndedAt !== undefined &&
        Date.now() - streamingThinking.streamingEndedAt <
          LIVE_REASONING_LINGER_MS))

  const latestBashOutputUUID = useMemo(() => {
    for (let i = collapsed.length - 1; i >= 0; i--) {
      const message = collapsed[i]!
      if (message.type !== 'user') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      const isShell = content.some(
        block =>
          block.type === 'text' &&
          (block.text.startsWith('<bash-stdout') ||
            block.text.startsWith('<bash-stderr')),
      )
      if (isShell) return message.uuid
    }
    return null
  }, [collapsed])

  const hasRealConversation = useMemo(
    () =>
      computeHasRealConversation(
        collapsed as Parameters<typeof computeHasRealConversation>[0],
      ),
    [collapsed],
  )
  return { withheldDisclosure, visible, liveReceipt, lastThinkingBlockId, liveReasoningVisible, latestBashOutputUUID, hasRealConversation }
}
