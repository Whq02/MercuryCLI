import { isThinkingBlock } from '../messages/apiFilters.js'
import type { DeadThinkingMark } from '../message-shapes/message.js'
import type { Message } from '../message-shapes/message.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { expandPath } from '../../platform/files/path.js'
import { isRecord } from '../../platform/primitives/isRecord.js'
import type { FileStateCache } from '../../platform/files/fileStateCache.js'
import { estimateContentTokens, roughTokenCountEstimationForMessages } from '../../models/facts/tokenEstimation.js'
import { stripThinkingFromIndex } from '../messages/apiFilters.js'
import { digestClearedToolResult, isClearedOrDigested } from './pruneDigest.js'
import { isBelowPlaceholderFloor, isProtectedFromPruning, PROTECT_NEWEST_TOOL_OUTPUT_TOKENS, PRUNE_MINIMUM_SAVING_TOKENS } from './pruneProtections.js'
import { clearFoldWarningSuppression, suppressFoldWarning } from './foldWarningSuppression.js'
import { getTimeBasedPruneConfig } from './timeBasedPruneConfig.js'
import { REPEATED_RESULT_TAG } from '../../tools/kit/toolLimits.js'
import { READ_TOOL_NAME } from '../../tools/kit/names/read.js'
import { EDIT_TOOL_NAME } from '../../tools/kit/names/edit.js'
import { WRITE_TOOL_NAME } from '../../tools/kit/names/write.js'

type PruneResult = {
  messages: Message[]
  pruned?: {
    cleared: number
    tokensSaved: number
    clearedIds: string[]
  }
  deadMarks?: DeadThinkingMark[]
}

type PruneTrigger = {
  pressure: true
  supersededOnly?: true
  minimumTokensSaved?: number
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      total += estimateContentTokens(block)
    }
  }
  return Math.ceil((total * 4) / 3)
}

export function estimateContextTokens(messages: Message[], model?: string): number {
  return roughTokenCountEstimationForMessages(messages, model)
}


const MAIN_THREAD_PREFIX = 'main_thread'

function isMainThreadSource(querySource: string | undefined): boolean {
  return querySource === undefined || querySource.startsWith(MAIN_THREAD_PREFIX)
}

function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: string | undefined,
): { gapMinutes: number; config: ReturnType<typeof getTimeBasedPruneConfig> } | null {
  const config = getTimeBasedPruneConfig()
  if (!config.enabled) return null
  if (querySource === undefined) return null
  if (!isMainThreadSource(querySource)) return null

  let lastAssistant: Message | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.type === 'assistant') {
      lastAssistant = messages[index]
      break
    }
  }
  if (lastAssistant === undefined) return null
  const timestamp = Date.parse((lastAssistant as { timestamp?: string }).timestamp ?? '')
  const gapMinutes = (Date.now() - timestamp) / 60_000
  if (!Number.isFinite(gapMinutes)) return null
  if (gapMinutes < config.thresholdMinutes) return null
  return { gapMinutes, config }
}

const PERSISTED_PATH_PHRASE = 'Full output saved to: '

function persistedReferenceOf(content: unknown): string | undefined {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map(item => ((item as { type?: string }).type === 'text' ? String((item as { text?: unknown }).text ?? '') : '')).join('\n')
        : ''
  const at = text.indexOf(PERSISTED_PATH_PHRASE)
  if (at === -1) return undefined
  const start = text.lastIndexOf('\n', at) + 1
  const end = text.indexOf('\n', at)
  return text.slice(start, end === -1 ? undefined : end)
}

function containsRepeatedResultTag(content: unknown): boolean {
  if (typeof content === 'string') return content.includes(REPEATED_RESULT_TAG)
  if (!Array.isArray(content)) return false
  return content.some(
    item =>
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string' &&
      item.text.includes(REPEATED_RESULT_TAG),
  )
}

export function projectTimeBasedPrune(
  messages: Message[],
  querySource: string | undefined,
  trigger?: PruneTrigger,
): {
  messages: Message[]
  cleared: number
  tokensSaved: number
  gapMinutes: number
  clearedReadPaths: string[]
  clearedIds: string[]
  deadMarks: DeadThinkingMark[]
} | null {
  let gapMinutes: number
  let config: ReturnType<typeof getTimeBasedPruneConfig>
  if (trigger?.pressure === true) {
    config = getTimeBasedPruneConfig()
    gapMinutes = 0
  } else {
    const evaluated = evaluateTimeBasedTrigger(messages, querySource)
    if (evaluated === null) return null
    gapMinutes = evaluated.gapMinutes
    config = evaluated.config
  }

  const supersededOnly = trigger?.supersededOnly === true
  const candidateIds: string[] = []
  const readPathsById = new Map<string, string>()
  const fileOpPathById = new Map<string, string>()

  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_use') continue
      const id = block.id
      const name = block.name
      const filePath = isRecord(block.input) && typeof block.input.file_path === 'string' ? block.input.file_path : undefined
      if (
        supersededOnly &&
        filePath !== undefined &&
        (name === READ_TOOL_NAME || name === EDIT_TOOL_NAME || name === WRITE_TOOL_NAME)
      ) {
        fileOpPathById.set(id, filePath)
      }
      if (isProtectedFromPruning(name, block.input)) continue
      candidateIds.push(id)
      if (name === READ_TOOL_NAME && filePath !== undefined) {
        readPathsById.set(id, filePath)
      }
    }
  }

  if (candidateIds.length === 0) return null

  const resultTokensById = new Map<string, number>()
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type !== 'tool_result') continue
      resultTokensById.set(block.tool_use_id, estimateContentTokens(block.content))
    }
  }

  const keepCount = Math.max(1, config.keepRecent)
  const protectedIds = new Set<string>(candidateIds.slice(-keepCount))
  let newestTokens = 0
  for (let i = candidateIds.length - 1; i >= 0; i--) {
    const id = candidateIds[i]!
    const tokens = resultTokensById.get(id) ?? 0
    if (newestTokens + tokens > PROTECT_NEWEST_TOOL_OUTPUT_TOKENS) break
    newestTokens += tokens
    protectedIds.add(id)
  }

  let clearIds = new Set<string>(candidateIds.filter(id => !protectedIds.has(id)))
  if (clearIds.size === 0) return null

  if (supersededOnly) {
    const latestByPath = new Map<string, string>()
    const supersededIds = new Set<string>()
    for (const message of messages) {
      if (message.type !== 'user') continue
      if (isRecord(message.toolUseResult) && message.toolUseResult.type === 'file_unchanged') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        if (block.is_error === true) continue
        if (isClearedOrDigested(block.content)) continue
        if (containsRepeatedResultTag(block.content)) continue
        const filePath = fileOpPathById.get(block.tool_use_id)
        if (filePath === undefined) continue
        const earlier = latestByPath.get(filePath)
        if (earlier !== undefined && earlier !== block.tool_use_id) {
          supersededIds.add(earlier)
        }
        latestByPath.set(filePath, block.tool_use_id)
      }
    }
    clearIds = new Set<string>([...clearIds].filter(id => supersededIds.has(id)))
    if (clearIds.size === 0) return null
  }

  const minimumSaving =
    trigger?.pressure === true
      ? (trigger.minimumTokensSaved ?? 0)
      : PRUNE_MINIMUM_SAVING_TOKENS
  if (minimumSaving > 0) {
    let availableTokens = 0
    for (const message of messages) {
      if (message.type !== 'user') continue
      const content = message.message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (block.type !== 'tool_result') continue
        if (!clearIds.has(block.tool_use_id)) continue
        if (isClearedOrDigested(block.content)) continue
        const tokens = estimateContentTokens(block.content)
        if (isBelowPlaceholderFloor(tokens)) continue
        availableTokens += tokens
      }
    }
    if (availableTokens < minimumSaving) return null
  }

  let cleared = 0
  let tokensSaved = 0
  let firstModifiedIndex = -1
  const clearedIds: string[] = []
  const clearedReadPaths: string[] = []

  const nextMessages = messages.map((message, msgIndex) => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let modified = false
    const nextContent = message.message.content.map(block => {
      if (block.type !== 'tool_result') return block
      if (!clearIds.has(block.tool_use_id)) return block
      if (isClearedOrDigested(block.content)) return block
      const originalTokens = estimateContentTokens(block.content)
      if (isBelowPlaceholderFloor(originalTokens)) return block
      const digest = digestClearedToolResult(block.content)
      const persistedRef = persistedReferenceOf(block.content)
      const replacement = persistedRef !== undefined ? `${digest}\n${persistedRef}` : digest
      const saved = supersededOnly
        ? Math.max(0, originalTokens - estimateContentTokens(replacement))
        : originalTokens
      tokensSaved += saved
      cleared++
      clearedIds.push(block.tool_use_id)
      const readPath = readPathsById.get(block.tool_use_id)
      if (readPath !== undefined) clearedReadPaths.push(readPath)
      modified = true
      return { ...block, content: replacement }
    })
    if (!modified) return message
    if (firstModifiedIndex === -1) firstModifiedIndex = msgIndex
    return {
      ...message,
      message: {
        ...message.message,
        content: nextContent,
      },
    }
  })

  if (cleared === 0 || tokensSaved === 0 || tokensSaved < minimumSaving || firstModifiedIndex === -1) {
    return null
  }

  const deadMarks: DeadThinkingMark[] = []
  for (let i = firstModifiedIndex; i < nextMessages.length; i++) {
    const message = nextMessages[i]
    if (message?.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    const messageId = message.message.id
    if (typeof messageId !== 'string' || messageId === '') continue
    for (let blockIndex = 0; blockIndex < content.length; blockIndex++) {
      if (isThinkingBlock(content[blockIndex])) {
        deadMarks.push({ messageId, blockIndex })
      }
    }
  }

  const strippedMessages = stripThinkingFromIndex(nextMessages, firstModifiedIndex)
  return {
    messages: strippedMessages,
    cleared,
    tokensSaved,
    gapMinutes,
    clearedReadPaths,
    clearedIds,
    deadMarks,
  }
}


export async function pruneMessages(
  messages: Message[],
  _toolUseContext?: unknown,
  querySource?: string,
  invalidate?: {
    readFileState: Pick<FileStateCache, 'delete'>
  },
  trigger?: PruneTrigger,
): Promise<PruneResult> {
  clearFoldWarningSuppression()
  const projected = projectTimeBasedPrune(messages, querySource, trigger)
  if (projected === null) {
    return { messages }
  }
  logForDebugging(
    trigger?.pressure === true
      ? `pressure microcompact (${trigger.minimumTokensSaved !== undefined ? 'context size' : 'context overflow'}): cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`
      : `time-based microcompact: gap ${Math.round(projected.gapMinutes)}min ≥ ${getTimeBasedPruneConfig().thresholdMinutes}min — cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`,
  )
  suppressFoldWarning()
  if (invalidate !== undefined) {
    for (const rawPath of projected.clearedReadPaths) {
      invalidate.readFileState.delete(expandPath(rawPath))
      invalidate.readFileState.delete(rawPath)
    }
  }
  return {
    messages: projected.messages,
    pruned: {
      cleared: projected.cleared,
      tokensSaved: projected.tokensSaved,
      clearedIds: projected.clearedIds,
    },
    deadMarks: projected.deadMarks,
  }
}
