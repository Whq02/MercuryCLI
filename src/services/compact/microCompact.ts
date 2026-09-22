import { isThinkingBlock } from '../../utils/messages/apiFilters.js'
import type { DeadThinkingMark } from '../../types/message.js'
import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { expandPath } from '../../utils/path.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { OwnerKey } from '../../services/run/ownerKey.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import { OwnerScopedStore } from '../../services/run/ownerScopedStore.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'
import { stripThinkingFromIndex } from '../../utils/messages/apiFilters.js'
import { digestClearedToolResult, isClearedOrDigested } from './microCompactDigest.js'
import { isBelowPlaceholderFloor, isProtectedFromPruning, PROTECT_NEWEST_TOOL_OUTPUT_TOKENS, PRUNE_MINIMUM_SAVING_TOKENS } from './pruneProtections.js'
import { clearCompactWarningSuppression, suppressCompactWarning } from './compactWarningState.js'
import { getTimeBasedMCConfig } from './timeBasedMCConfig.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../../tools/FileEditTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../../tools/FileWriteTool/prompt.js'

export const TIME_BASED_MC_CLEARED_MESSAGE = '[stale tool result pruned — content cleared]'

export type PendingCacheEdits = {
  userMessageIndex: number
  block: unknown
}

export type MicrocompactResult = {
  messages: Message[]
  compactionInfo?: {
    trigger: string
    deletedToolIds: string[]
    baselineCacheDeletedTokens: number | null
  }
  pruned?: { cleared: number; tokensSaved: number; clearedIds: string[] }
  deadMarks?: DeadThinkingMark[]
}

export type MicrocompactTrigger = { pressure: true; supersededOnly?: true; minimumTokensSaved?: number }


const MEDIA_BLOCK_TOKENS = 2000

function estimateToolResultTokens(content: unknown): number {
  if (content === undefined || content === null) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const item of content) {
    const record = item as { type?: string; text?: unknown }
    if (record.type === 'text') {
      total += roughTokenCountEstimation(String(record.text ?? ''))
    } else if (record.type === 'image' || record.type === 'document') {
      total += MEDIA_BLOCK_TOKENS
    }
  }
  return total
}

function estimateBlockTokens(block: unknown): number {
  const record = block as Record<string, unknown>
  switch (record.type) {
    case 'text':
      return roughTokenCountEstimation(String(record.text ?? ''))
    case 'tool_result':
      return estimateToolResultTokens(record.content)
    case 'image':
    case 'document':
      return MEDIA_BLOCK_TOKENS
    case 'thinking':
      return roughTokenCountEstimation(String(record.thinking ?? ''))
    case 'redacted_thinking':
      return roughTokenCountEstimation(String(record.data ?? ''))
    case 'tool_use':
      return roughTokenCountEstimation(
        `${String(record.name ?? '')}${JSON.stringify(record.input ?? null)}`,
      )
    default:
      return roughTokenCountEstimation(JSON.stringify(record) ?? '')
  }
}

export function estimateMessageTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) total += estimateBlockTokens(block)
  }
  return Math.ceil((total * 4) / 3)
}

export function estimateContextTokens(messages: Message[]): number {
  let total = 0
  for (const message of messages) {
    switch (message.type) {
      case 'user':
      case 'assistant': {
        const content = (message as { message?: { content?: unknown } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) total += estimateBlockTokens(block)
        } else if (typeof content === 'string') {
          total += roughTokenCountEstimation(content)
        }
        break
      }
      case 'attachment':
        total += roughTokenCountEstimation(JSON.stringify((message as { attachment?: unknown }).attachment ?? null))
        break
      case 'system': {
        const content = (message as { content?: unknown }).content
        total += roughTokenCountEstimation(typeof content === 'string' ? content : '')
        break
      }
      default:
        break
    }
  }
  return Math.ceil((total * 4) / 3)
}


const MAIN_THREAD_PREFIX = 'repl_main_thread'

function isMainThreadSource(querySource: string | undefined): boolean {
  return querySource === undefined || querySource.startsWith(MAIN_THREAD_PREFIX)
}

export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: string | undefined,
): { gapMinutes: number; config: ReturnType<typeof getTimeBasedMCConfig> } | null {
  const config = getTimeBasedMCConfig()
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
  return text.split('\n').find(line => line.includes(PERSISTED_PATH_PHRASE))
}

export function projectTimeBasedMicrocompact(
  messages: Message[],
  querySource: string | undefined,
  trigger?: MicrocompactTrigger,
): {
  messages: Message[]
  cleared: number
  tokensSaved: number
  gapMinutes: number
  clearedReadPaths: string[]
  clearedIds: string[]
  deadMarks: DeadThinkingMark[]
} | null {
  const fired =
    trigger?.pressure === true
      ? { gapMinutes: 0, config: getTimeBasedMCConfig() }
      : evaluateTimeBasedTrigger(messages, querySource)
  if (fired === null) return null

  const compactableIds: string[] = []
  const readPathById = new Map<string, string>()
  const filePathById = trigger?.supersededOnly === true ? new Map<string, string>() : null
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      const record = block as { type?: string; id?: string; name?: string; input?: unknown }
      if (record.type === 'tool_use' && typeof record.id === 'string' && typeof record.name === 'string') {
        if (filePathById !== null && (record.name === FILE_READ_TOOL_NAME || record.name === FILE_EDIT_TOOL_NAME || record.name === FILE_WRITE_TOOL_NAME)) {
          const filePath = (record.input as { file_path?: unknown } | undefined)?.file_path
          if (typeof filePath === 'string') filePathById.set(record.id, filePath)
        }
        if (!isProtectedFromPruning(record.name, record.input)) {
          compactableIds.push(record.id)
          if (record.name === FILE_READ_TOOL_NAME) {
            const filePath = (record.input as { file_path?: unknown } | undefined)?.file_path
            if (typeof filePath === 'string') readPathById.set(record.id, filePath)
          }
        }
      }
    }
  }

  const keepCount = Math.max(1, fired.config.keepRecent)
  const tokensById = new Map<string, number>()
  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
    for (const block of message.message.content) {
      if (block.type === 'tool_result') tokensById.set(block.tool_use_id, estimateToolResultTokens(block.content))
    }
  }
  const kept = new Set(compactableIds.slice(Math.max(0, compactableIds.length - keepCount)))
  let newest = 0
  for (let index = compactableIds.length - 1; index >= 0; index--) {
    const id = compactableIds[index]!
    newest += tokensById.get(id) ?? 0
    if (newest > PROTECT_NEWEST_TOOL_OUTPUT_TOKENS) break
    kept.add(id)
  }
  const clearSet = new Set(compactableIds.filter(id => !kept.has(id)))
  if (clearSet.size === 0) return null
  const minimumSaving = trigger?.pressure === true ? trigger.minimumTokensSaved ?? 0 : PRUNE_MINIMUM_SAVING_TOKENS
  if (filePathById !== null) {
    const latestByPath = new Map<string, string>()
    const supersededIds = new Set<string>()
    for (const message of messages) {
      if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
      if ((message.toolUseResult as { type?: string } | undefined)?.type === 'file_unchanged') continue
      for (const block of message.message.content) {
        if (block.type !== 'tool_result' || block.is_error === true || isClearedOrDigested(block.content)) continue
        const path = filePathById.get(block.tool_use_id)
        if (path === undefined) continue
        const prior = latestByPath.get(path)
        if (prior !== undefined) supersededIds.add(prior)
        latestByPath.set(path, block.tool_use_id)
      }
    }
    for (const id of clearSet) if (!supersededIds.has(id)) clearSet.delete(id)
    if (clearSet.size === 0) return null
  }

  if (minimumSaving > 0) {
    let availableTokens = 0
    for (const message of messages) {
      if (message.type !== 'user' || !Array.isArray(message.message.content)) continue
      for (const block of message.message.content) {
        if (block.type === 'tool_result' && clearSet.has(block.tool_use_id) && !isClearedOrDigested(block.content)) {
          availableTokens += estimateToolResultTokens(block.content)
        }
      }
    }
    if (availableTokens < minimumSaving) return null
  }

  let tokensSaved = 0
  let cleared = 0
  const clearedReadPaths: string[] = []
  const clearedIds: string[] = []
  const projected = messages.map(message => {
    if (message.type !== 'user') return message
    const content = (message as { message?: { content?: unknown } }).message?.content
    if (!Array.isArray(content)) return message
    let touched = false
    const rebuilt = content.map(rawBlock => {
      const block = rawBlock as { type?: string; tool_use_id?: string; content?: never }
      if (
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        clearSet.has(block.tool_use_id) &&
        !isClearedOrDigested(block.content) &&
        !isBelowPlaceholderFloor(estimateToolResultTokens(block.content))
      ) {
        touched = true
        cleared++
        const digest = digestClearedToolResult(block.content)
        const reference = persistedReferenceOf(block.content)
        const replacement = reference === undefined ? digest : `${digest}\n${reference}`
        tokensSaved += estimateToolResultTokens(block.content) - (trigger?.supersededOnly === true ? estimateToolResultTokens(replacement) : 0)
        clearedIds.push(block.tool_use_id)
        const readPath = readPathById.get(block.tool_use_id)
        if (readPath !== undefined) clearedReadPaths.push(readPath)
        return { ...block, content: replacement }
      }
      return rawBlock
    })
    if (!touched) return message
    return {
      ...message,
      message: { ...(message as { message: object }).message, content: rebuilt },
    } as Message
  })

  if (tokensSaved === 0 || tokensSaved < minimumSaving) return null
  const firstCleared = projected.findIndex((message, index) => message !== messages[index])
  const withValidThinking = firstCleared === -1 ? projected : stripThinkingFromIndex(projected, firstCleared)
  const deadMarks: DeadThinkingMark[] = []
  if (firstCleared !== -1) {
    for (let index = firstCleared; index < projected.length; index++) {
      const message = projected[index]!
      if (message.type !== 'assistant') continue
      const content = message.message.content
      if (!Array.isArray(content) || typeof message.message.id !== 'string') continue
      content.forEach((block, blockIndex) => {
        if (isThinkingBlock(block)) deadMarks.push({ messageId: message.message.id, blockIndex })
      })
    }
  }
  return { messages: withValidThinking, cleared, tokensSaved, gapMinutes: fired.gapMinutes, clearedReadPaths, clearedIds, deadMarks }
}


type CacheEditState = {
  registeredToolIds: string[]
  pinnedEdits: PendingCacheEdits[]
  pendingEdits: PendingCacheEdits | null
}

const cacheEditStore = new OwnerScopedStore<CacheEditState>({
  name: 'microcompact-cache-edits',
  create: () => ({ registeredToolIds: [], pinnedEdits: [], pendingEdits: null }),
})

function ownerOrMain(owner: OwnerKey | undefined): OwnerKey {
  return owner ?? processMainOwner()
}

export const consumePendingCacheEdits: (owner?: OwnerKey) => PendingCacheEdits | null = function (
  owner,
) {
  const state = cacheEditStore.get(ownerOrMain(owner))
  const pending = state.pendingEdits
  state.pendingEdits = null
  return pending
}

export const getPinnedCacheEdits: (owner?: OwnerKey) => PendingCacheEdits[] = function (owner) {
  const state = cacheEditStore.peek(ownerOrMain(owner))
  return state === undefined ? [] : state.pinnedEdits
}

export const pinCacheEdits: (
  userMessageIndex: number,
  block: unknown,
  owner?: OwnerKey,
) => void = function (userMessageIndex, block, owner) {
  const state = cacheEditStore.get(ownerOrMain(owner))
  state.pinnedEdits.push({ userMessageIndex, block })
}

export const markToolsSentToAPIState: (owner?: OwnerKey) => void = function (owner) {
  const state = cacheEditStore.peek(ownerOrMain(owner))
  if (state === undefined) return
  state.registeredToolIds = []
}

export const resetMicrocompactState: (owner?: OwnerKey) => void = function (owner) {
  const key = ownerOrMain(owner)
  const state = cacheEditStore.peek(key)
  if (state === undefined) return
  state.registeredToolIds = []
  state.pinnedEdits = []
  state.pendingEdits = null
}


export async function microcompactMessages(
  messages: Message[],
  _toolUseContext?: unknown,
  querySource?: string,
  invalidate?: {
    readFileState: Pick<FileStateCache, 'delete'>
  },
  trigger?: MicrocompactTrigger,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  const projected = projectTimeBasedMicrocompact(messages, querySource, trigger)
  if (projected !== null) {
    const config = getTimeBasedMCConfig()
    logForDebugging(
      trigger?.pressure === true
        ? `pressure microcompact (${trigger.supersededOnly === true ? 'context size' : 'context overflow'}): cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`
        : `time-based microcompact: gap ${Math.round(projected.gapMinutes)}min ≥ ${config.thresholdMinutes}min — cleared ${projected.cleared} tool results (~${projected.tokensSaved} tokens)`,
    )
    suppressCompactWarning()
    resetMicrocompactState()
    if (invalidate) {
      for (const clearedPath of projected.clearedReadPaths) {
        invalidate.readFileState.delete(expandPath(clearedPath))
        invalidate.readFileState.delete(clearedPath)
      }
    }
    return {
      messages: projected.messages,
      pruned: { cleared: projected.cleared, tokensSaved: projected.tokensSaved, clearedIds: projected.clearedIds },
      deadMarks: projected.deadMarks,
    }
  }

  return { messages }
}
