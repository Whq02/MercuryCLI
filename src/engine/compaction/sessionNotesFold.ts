import type { AssistantMessage, Message, UserMessage } from '../message-shapes/message.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { createAttachmentMessage } from '../attachment-shapes/attachmentMessage.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  findLastCompactBoundaryIndex,
  isCompactBoundaryMessage,
} from '../messages/messages.js'
import { getSessionMemoryPath } from '../../permissions/rules/filesystem.js'
import { fireHooks } from '../../integrations/event-hooks/fire.js'
import { hookRowsOfResult } from '../../integrations/event-hooks/rows.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { getTranscriptPath } from '../../sessions/transcripts/paths.js'
import { tokenCountFromLastAPIResponse } from '../context-window/contextTokenCount.js'
import { extractDiscoveredToolNames } from '../messages/toolSearch.js'
import { isSessionMemoryEmpty, truncateSessionMemoryForCompact } from '../../sessions/session-memory/template.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../../sessions/session-memory/extractionState.js'
import {
  annotateBoundaryWithPreservedSegment,
  annotateBoundaryWithWork,
  buildPostCompactMessages,
  type CompactionResult,
  createAsyncAgentAttachmentsIfNeeded,
  foldSizes,
} from './foldConversation.js'
import type { ToolUseContext } from '../../tools/kit/tool.js'
import { estimateContextTokens, estimateMessageTokens } from './pruneToolResults.js'
import { getCompactUserSummaryMessage } from './summariserPrompt.js'


type SessionMemoryCompactConfig = {
  minTokensToPreserve: number
  minTextBlockMessages: number
  maxTokensToPreserve: number
}

const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokensToPreserve: 10_000,
  minTextBlockMessages: 5,
  maxTokensToPreserve: 40_000,
}

let config: SessionMemoryCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }
export function shouldUseSessionMemoryCompaction(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_SM_COMPACT'))
}


function hasTextBlocks(message: Message): boolean {
  if (message.type === 'assistant') {
    const content = (message as AssistantMessage).message.content
    return Array.isArray(content) && content.some(block => (block as { type?: string }).type === 'text')
  }
  if (message.type === 'user') {
    const content = (message as UserMessage).message.content
    if (typeof content === 'string') return content !== ''
    return Array.isArray(content) && content.some(block => (block as { type?: string }).type === 'text')
  }
  return false
}

function toolResultIdsOf(message: Message): string[] {
  if (message.type !== 'user') return []
  const content = (message as UserMessage).message.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    const record = block as { type?: string; tool_use_id?: string }
    if (record.type === 'tool_result' && typeof record.tool_use_id === 'string') ids.push(record.tool_use_id)
  }
  return ids
}

function toolUseIdsOf(message: Message): string[] {
  if (message.type !== 'assistant') return []
  const content = (message as AssistantMessage).message.content
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const block of content) {
    const record = block as { type?: string; id?: string }
    if (record.type === 'tool_use' && typeof record.id === 'string') ids.push(record.id)
  }
  return ids
}

function adjustIndexToPreserveAPIInvariants(messages: Message[], startIndex: number): number {
  if (startIndex <= 0 || startIndex >= messages.length) return startIndex
  let index = startIndex

  const needed = new Set<string>()
  const present = new Set<string>()
  for (let i = index; i < messages.length; i++) {
    for (const id of toolResultIdsOf(messages[i] as Message)) needed.add(id)
    for (const id of toolUseIdsOf(messages[i] as Message)) present.add(id)
  }
  for (const id of present) needed.delete(id)
  let cursor = index - 1
  while (needed.size > 0 && cursor >= 0) {
    const message = messages[cursor] as Message
    const supplied = toolUseIdsOf(message).filter(id => needed.has(id))
    if (supplied.length > 0) {
      index = cursor
      for (const id of supplied) needed.delete(id)
    }
    cursor--
  }

  const keptIds = new Set<string>()
  for (let i = index; i < messages.length; i++) {
    const message = messages[i] as Message
    if (message.type === 'assistant') keptIds.add((message as AssistantMessage).message.id)
  }
  cursor = index - 1
  while (cursor >= 0) {
    const message = messages[cursor] as Message
    if (message.type === 'assistant' && keptIds.has((message as AssistantMessage).message.id)) {
      index = cursor
    }
    cursor--
  }
  return index
}
function calculateMessagesToKeepIndex(messages: Message[], lastSummarizedIndex: number): number {
  if (messages.length === 0) return 0
  let startIndex = lastSummarizedIndex >= 0 ? Math.min(lastSummarizedIndex + 1, messages.length) : messages.length

  let tokens = 0
  let textMessages = 0
  for (let i = startIndex; i < messages.length; i++) {
    const message = messages[i]!
    tokens += estimateMessageTokens([message])
    if (hasTextBlocks(message)) textMessages++
  }

  const lastBoundary = findLastCompactBoundaryIndex(messages)
  const minIndex = lastBoundary >= 0 ? lastBoundary + 1 : 0

  while (
    startIndex > minIndex &&
    tokens < config.maxTokensToPreserve &&
    !(tokens >= config.minTokensToPreserve && textMessages >= config.minTextBlockMessages)
  ) {
    startIndex--
    const message = messages[startIndex]!
    tokens += estimateMessageTokens([message])
    if (hasTextBlocks(message)) textMessages++
  }

  return adjustIndexToPreserveAPIInvariants(messages, startIndex)
}

export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: string,
  autoCompactThreshold?: number,
  rosterContext?: Pick<ToolUseContext, 'getAppState' | 'agentId' | 'options'>,
  trigger?: 'auto' | 'manual',
): Promise<CompactionResult | null> {
  void agentId
  if (!shouldUseSessionMemoryCompaction()) return null

  try {
    await waitForSessionMemoryExtraction()
    const sessionMemory = await getSessionMemoryContent()
    if (sessionMemory === null || (await isSessionMemoryEmpty(sessionMemory))) {
      return null
    }

    const lastSummarizedId = getLastSummarizedMessageId()
    let lastSummarizedIndex: number
    if (lastSummarizedId !== undefined) {
      lastSummarizedIndex = messages.findIndex(message => message.uuid === lastSummarizedId)
      if (lastSummarizedIndex === -1) return null
    } else {
      lastSummarizedIndex = messages.length - 1
    }

    const keepIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex)
    const messagesToKeep = messages.slice(keepIndex).filter(message => !isCompactBoundaryMessage(message))

    const effectiveTrigger: 'auto' | 'manual' = trigger ?? 'auto'
    const preCompactTokenCount = tokenCountFromLastAPIResponse(messages)
    const lastMessageUuid = messages.at(-1)?.uuid
    const boundaryMarker = createCompactBoundaryMessage(
      effectiveTrigger,
      preCompactTokenCount,
      lastMessageUuid,
    )

    const discoveredTools = [...extractDiscoveredToolNames(messages)].sort()
    if (discoveredTools.length > 0) {
      boundaryMarker.compactMetadata.preCompactDiscoveredTools = discoveredTools
    }

    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(sessionMemory)
    let summaryText = getCompactUserSummaryMessage(
      truncatedContent,
      true,
      getTranscriptPath(),
      messagesToKeep.length > 0,
    )
    if (wasTruncated) {
      summaryText += `\n\nThe session memory was truncated for compaction; the full text is on disk at ${getSessionMemoryPath()}.`
    }

    const summaryMessage = createUserMessage({
      content: summaryText,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })
    const summaryMessages: UserMessage[] = [summaryMessage]

    const attachments = rosterContext
      ? await createAsyncAgentAttachmentsIfNeeded(rosterContext as ToolUseContext)
      : []

    const annotatedBoundary = annotateBoundaryWithPreservedSegment(
      boundaryMarker,
      summaryMessage.uuid,
      messagesToKeep,
    )
    annotateBoundaryWithWork(annotatedBoundary, messages, messagesToKeep, summaryMessage.uuid)

    const summaryTokens = estimateContextTokens(summaryMessages)
    const proposedBeforeHooks: Message[] = [
      annotatedBoundary,
      ...summaryMessages,
      ...messagesToKeep,
      ...attachments,
    ]
    const preHookEstimate = estimateContextTokens(proposedBeforeHooks)
    if (autoCompactThreshold !== undefined && preHookEstimate >= autoCompactThreshold) {
      return null
    }

    const afterHook = await fireHooks(
      'compaction.after',
      {
        method: 'notes',
        trigger: effectiveTrigger,
        tokens_before: preCompactTokenCount,
        tokens_after: preHookEstimate,
      },
      {
        scope: {
          sessionId: getSessionId(),
          ...(rosterContext?.agentId !== undefined ? { crewmateId: rosterContext.agentId } : {}),
        },
      },
    )
    const hookResults: Message[] = [
      ...hookRowsOfResult(afterHook).map(row => createAttachmentMessage(row)),
      ...afterHook.answer.contexts.map(text => createUserMessage({ content: text, isMeta: true })),
    ]

    const result: CompactionResult = {
      boundaryMarker: annotatedBoundary,
      summaryMessages,
      messagesToKeep,
      attachments,
      hookResults,
      preCompactTokenCount,
      postCompactTokenCount: summaryTokens,
      truePostCompactTokenCount: summaryTokens,
      compactionUsage: undefined,
    }

    const finalEstimate = estimateContextTokens(buildPostCompactMessages(result))
    if (autoCompactThreshold !== undefined && finalEstimate >= autoCompactThreshold) {
      return null
    }
    result.postCompactTokenCount = finalEstimate
    result.truePostCompactTokenCount = finalEstimate

    if (effectiveTrigger === 'manual') {
      const sizes = foldSizes(messages, rosterContext?.options?.engineModel, preCompactTokenCount, estimateContextTokens)
      if (finalEstimate >= sizes.before) {
        return null
      }
      if (preCompactTokenCount > 0) {
        result.truePostCompactTokenCount = sizes.after(finalEstimate).tokens
      }
    }

    return result
  } catch (error) {
    logForDebugging(`sessionMemoryCompact: attempt failed: ${String(error)}`)
    return null
  }
}
