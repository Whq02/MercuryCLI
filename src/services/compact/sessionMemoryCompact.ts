import type { AssistantMessage, Message, UserMessage } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
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
import {
  checkFeatureGate_CACHED_MAY_BE_STALE,
  getDynamicConfig_CACHED_MAY_BE_STALE,
} from '../analytics/featureGates.js'
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
  createPlanAttachmentIfNeeded,
} from './compact.js'
import { estimateContextTokens, estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'

/**
 * Alternative compaction that reuses an already-extracted session memory
 * instead of a summarisation call.
 */

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
let configInitialized = false

export function setSessionMemoryCompactConfig(partial: Partial<SessionMemoryCompactConfig>): void {
  config = { ...config, ...partial }
}

/** Returns a copy. */
export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
  return { ...config }
}

export function resetSessionMemoryCompactConfig(): void {
  config = { ...DEFAULT_SM_COMPACT_CONFIG }
  configInitialized = false
}

/** Fetched once per session; each field adopted only when present and positive. */
async function initializeConfig(): Promise<void> {
  if (configInitialized) return
  // Set BEFORE the await so a concurrent call does not double-fetch.
  configInitialized = true
  const remote = getDynamicConfig_CACHED_MAY_BE_STALE<Partial<SessionMemoryCompactConfig>>(
    'mercury_sm_compact_config',
    {},
  )
  const adopted: Partial<SessionMemoryCompactConfig> = {}
  for (const key of ['minTokensToPreserve', 'minTextBlockMessages', 'maxTokensToPreserve'] as const) {
    const value = remote?.[key]
    if (typeof value === 'number' && value > 0) adopted[key] = value
  }
  setSessionMemoryCompactConfig(adopted)
}

export function shouldUseSessionMemoryCompaction(): boolean {
  const pin = process.env.MERCURY_SM_COMPACT
  if (isEnvTruthy(pin)) return true
  if (isEnvDefinedFalsy(pin)) return false
  return (
    checkFeatureGate_CACHED_MAY_BE_STALE('mercury_session_memory') &&
    checkFeatureGate_CACHED_MAY_BE_STALE('mercury_sm_compact')
  )
}

// ---------------------------------------------------------------------------
// Keep-index calculation
// ---------------------------------------------------------------------------

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

/**
 * Two passes: tool pairing (every kept tool result must keep its tool use;
 * collected across EVERY kept message because streaming yields one message
 * per content block sharing an id) and thinking-block merging (earlier
 * assistant messages sharing a kept message id may carry the thinking block
 * the API normaliser merges into the same logical message).
 */
export function adjustIndexToPreserveAPIInvariants(messages: Message[], startIndex: number): number {
  if (startIndex <= 0 || startIndex >= messages.length) return startIndex
  let index = startIndex

  // Pass 1: tool pairing.
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

  // Pass 2: thinking-block merging.
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

  // Estimated PER MESSAGE and summed — the estimator rounds, so a slice
  // estimate would differ.
  let tokens = 0
  let textMessages = 0
  for (let i = start; i < messages.length; i++) {
    tokens += estimateMessageTokens([messages[i] as Message])
    if (hasTextBlocks(messages[i] as Message)) textMessages++
  }

  const meetsMax = () => tokens >= config.maxTokensToPreserve
  const meetsMins = () =>
    tokens >= config.minTokensToPreserve && textMessages >= config.minTextBlockMessages

  // The backwards walk is floored at the message after the last compact
  // boundary — crossing it would leave the on-disk parent chain with a gap
  // the loader prunes across.
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  const floor = boundaryIndex >= 0 ? boundaryIndex + 1 : 0

  if (!meetsMax() && !meetsMins()) {
    while (start > floor) {
      // Lower the index BEFORE testing so the message that trips the
      // maximum is included, not excluded.
      start--
      const message = messages[start] as Message
      tokens += estimateMessageTokens([message])
      if (hasTextBlocks(message)) textMessages++
      if (meetsMax() || meetsMins()) break
    }
  }

  return adjustIndexToPreserveAPIInvariants(messages, start)
}

// ---------------------------------------------------------------------------
// The attempt
// ---------------------------------------------------------------------------

export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: string,
  autoCompactThreshold?: number,
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
      // The boundary between summarised and unsummarised is unknowable.
      if (lastSummarizedIndex === -1) return null
    } else {
      // A resumed session where memory exists but the boundary is unknown:
      // nothing kept initially, and the expansion pass pulls back a window.
      lastSummarizedIndex = messages.length - 1
    }

    await initializeConfig()
    await waitForSessionMemoryExtraction()

    const keepIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex)
    // Old boundaries filtered: a re-yielded old boundary would trigger a
    // second REPL prune that discards the new boundary and summary.
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

    annotateBoundaryWithPreservedSegment(boundary, summaryMessage.uuid, kept)

    // No compaction API call: both post-compact figures are the estimate
    // over the summary messages (the whole-context estimator — the round
    // estimator reads a string-content summary as zero; FN-018 rank 9).
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
      // Compacting to something still over the threshold is pointless.
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
