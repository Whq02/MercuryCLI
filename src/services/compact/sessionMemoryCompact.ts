import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
  findLastCompactBoundaryIndex,
  isCompactBoundaryMessage,
} from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { getTranscriptPath } from '../../utils/sessionStorage/paths.js'
import { tokenCountFromLastAPIResponse } from '../../utils/tokens.js'
import { extractDiscoveredToolNames } from '../../utils/toolSearch.js'
import { isSessionMemoryEmpty, truncateSessionMemoryForCompact } from '../SessionMemory/prompts.js'
import {
  getLastSummarizedMessageId,
  getSessionMemoryContent,
  waitForSessionMemoryExtraction,
} from '../SessionMemory/sessionMemoryUtils.js'
import {
  annotateBoundaryWithPreservedSegment,
  buildPostCompactMessages,
  type CompactionResult,
  createAsyncAgentAttachmentsIfNeeded,
  createPlanAttachmentIfNeeded,
} from './compact.js'
import type { ToolUseContext } from '../../Tool.js'
import { estimateContextTokens, estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'


export type SessionMemoryCompactConfig = {
  minTokensToPreserve: number
  minTextBlockMessages: number
  maxTokensToPreserve: number
}

export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
  minTokensToPreserve: 10_000,
  minTextBlockMessages: 5,
  maxTokensToPreserve: 40_000,
}

let config: SessionMemoryCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG }

export function setSessionMemoryCompactConfig(partial: Partial<SessionMemoryCompactConfig>): void {
  config = { ...config, ...partial }
}

export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  return { ...config }
}

export function resetSessionMemoryCompactConfig(): void {
  config = { ...DEFAULT_SM_COMPACT_CONFIG }
}

export function shouldUseSessionMemoryCompaction(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_SM_COMPACT'))
}


export function hasTextBlocks(message: Message): boolean {
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

export function adjustIndexToPreserveAPIInvariants(messages: Message[], startIndex: number): number {
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

export function calculateMessagesToKeepIndex(messages: Message[], lastSummarizedIndex: number): number {
  if (messages.length === 0) return 0
  let start = lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length

  let tokens = 0
  let textMessages = 0
  for (let i = start; i < messages.length; i++) {
    tokens += estimateMessageTokens([messages[i] as Message])
    if (hasTextBlocks(messages[i] as Message)) textMessages++
  }

  const meetsMax = () => tokens >= config.maxTokensToPreserve
  const meetsMins = () =>
    tokens >= config.minTokensToPreserve && textMessages >= config.minTextBlockMessages

  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  const floor = boundaryIndex >= 0 ? boundaryIndex + 1 : 0

  if (!meetsMax() && !meetsMins()) {
    while (start > floor) {
      start--
      const message = messages[start] as Message
      tokens += estimateMessageTokens([message])
      if (hasTextBlocks(message)) textMessages++
      if (meetsMax() || meetsMins()) break
    }
  }

  return adjustIndexToPreserveAPIInvariants(messages, start)
}


export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: string,
  autoCompactThreshold?: number,
  rosterContext?: Pick<ToolUseContext, 'getAppState' | 'agentId'>,
): Promise<CompactionResult | null> {
  try {
    if (!shouldUseSessionMemoryCompaction()) return null
    const memory = await getSessionMemoryContent()
    if (memory === null) return null
    if (await isSessionMemoryEmpty(memory)) return null

    const lastSummarizedId = getLastSummarizedMessageId()
    let lastSummarizedIndex: number
    if (lastSummarizedId !== undefined) {
      lastSummarizedIndex = messages.findIndex(message => message.uuid === lastSummarizedId)
      if (lastSummarizedIndex === -1) return null
    } else {
      lastSummarizedIndex = messages.length - 1
    }

    await waitForSessionMemoryExtraction()

    const keepIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex)
    const kept = messages.slice(keepIndex).filter(message => !isCompactBoundaryMessage(message))

    const hookResults = await processSessionStartHooks('compact', { model: getMainLoopModel() })

    const preTokens = tokenCountFromLastAPIResponse(messages)
    const lastMessage = messages[messages.length - 1]
    const boundary = createCompactBoundaryMessage('auto', preTokens, lastMessage?.uuid)
    const discovered = extractDiscoveredToolNames(messages)
    if (discovered.size > 0) {
      boundary.compactMetadata.preCompactDiscoveredTools = [...discovered].sort()
    }

    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(memory)
    let summaryText = getCompactUserSummaryMessage(truncatedContent, true, getTranscriptPath(), true)
    if (wasTruncated) {
      summaryText += `\n\nThe session memory was truncated for compaction; the full text is on disk at ${getSessionMemoryPath()}.`
    }
    const summaryMessage = createUserMessage({
      content: summaryText,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    })

    const attachments = []
    const plan = createPlanAttachmentIfNeeded(agentId)
    if (plan !== null) attachments.push(plan)
    if (rosterContext !== undefined) {
      attachments.push(...(await createAsyncAgentAttachmentsIfNeeded(rosterContext as ToolUseContext)))
    }

    annotateBoundaryWithPreservedSegment(boundary, summaryMessage.uuid, kept)

    const summaryEstimate = estimateContextTokens([summaryMessage])
    const result: CompactionResult = {
      boundaryMarker: boundary,
      summaryMessages: [summaryMessage],
      messagesToKeep: kept,
      attachments,
      hookResults,
      userDisplayMessage: undefined,
      preCompactTokenCount: preTokens,
      postCompactTokenCount: summaryEstimate,
      truePostCompactTokenCount: summaryEstimate,
      compactionUsage: undefined,
    }

    const estimate = estimateContextTokens(buildPostCompactMessages(result))
    if (autoCompactThreshold !== undefined && estimate >= autoCompactThreshold) {
      return null
    }
    result.postCompactTokenCount = estimate
    result.truePostCompactTokenCount = estimate
    return result
  } catch (err) {
    logForDebugging(`sessionMemoryCompact: attempt failed: ${String(err)}`)
    return null
  }
}
